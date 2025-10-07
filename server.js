const { error } = require('console');
const http = require('http');
const fetch = require('node-fetch');//访问文件（需安装npm）
const semver = require('semver');//版本号识别（需安装npm）
const zlib = require('zlib'); // 用于解压 gzip
const tar = require('tar'); // 用于解析 tar 包(需安装npm)
const { Readable } = require('stream'); // 用于创建可读流
const { promisify } = require('util'); // 用于创建 Promise 化的函数
const pipeline = promisify(require('stream').pipeline); // 用于流式处理
const jschardet = require('jschardet');
const REGISTRY = process.env.REGISTRY || 'https://registry.npmjs.org';
function detectFileTypeByBuffer(buffer) {
  // 确保有足够的字节进行检测
  if (!buffer || buffer.length < 4) {
    return 'application/octet-stream';
  }

  // 获取前 16 个字节的十六进制和文本表示
  const headerHex = buffer.slice(0, 16).toString('hex').toUpperCase();
  const headerText = buffer.slice(0, 256).toString('utf8').toLowerCase();

  // 1. 二进制文件检测（基于魔数）
  if (headerHex.startsWith('FFD8FF')) return 'image/jpeg'; // JPEG
  if (headerHex.startsWith('89504E47')) return 'image/png'; // PNG
  if (headerHex.startsWith('47494638')) return 'image/gif'; // GIF
  if (headerHex.startsWith('25504446')) return 'application/pdf'; // PDF
  if (headerHex.startsWith('504B0304')) return 'application/zip'; // ZIP
  if (headerHex.startsWith('1F8B08')) return 'application/gzip'; // GZIP
  if (headerHex.startsWith('52617221')) return 'application/x-rar-compressed'; // RAR
  if (headerHex.startsWith('52494646') && headerHex.substring(16, 24) === '57454250')
    return 'image/webp'; // WEBP

  // 2. 文本文件检测（基于内容特征）

  // HTML 检测
  if (
    /<html\b/.test(headerText) ||
    /<!doctype\s+html>/.test(headerText) ||
    /<head>/.test(headerText) ||
    /<body>/.test(headerText) ||
    /<title>/.test(headerText)
  ) {
    return 'text/html';
  }

  // XML 检测
  if (headerText.startsWith('<?xml ') || /<[a-z]+:?[a-z]+\s+xmlns=/.test(headerText)) {
    return 'application/xml';
  }

  // JSON 检测
  const trimmedText = headerText.trim();
  if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
    try {
      // 尝试解析 JSON 验证有效性
      JSON.parse(buffer.toString('utf8'));
      return 'application/json';
    } catch (e) {
      // 无效 JSON，可能是 JavaScript 文件
    }
  }

  // JavaScript 检测
  if (/^\s*(?:import\s|export\s|function\s|class\s|var\s|let\s|const\s|\/\*\*|\/\/)/.test(headerText)) {
    return 'application/javascript';
  }
  // CSS 检测
  if (/^\s*@import\s+url|^\s*\/\*|^\s*body\s*\{/.test(headerText)) {
    return 'text/css';
  }
  // SVG 检测
  if (/<svg\s+xmlns=/.test(headerText)) {
    return 'image/svg+xml';
  }

  // Markdown 检测
  if (/^#\s+\w+|^\*\*\w+\*\*/.test(headerText)) {
    return 'text/markdown';
  }

  // 3. 纯文本检测
  if (isTextBuffer(buffer)) {
    // 纯文本文件
    return 'text/plain';
  }

  // 4. 默认二进制类型
  return 'application/octet-stream';
}
// 检测是否是纯文本文件
function isTextBuffer(buffer) {
  // 检查前 512 字节是否包含不可打印字符
  const chunk = buffer.slice(0, Math.min(buffer.length, 512));
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i];
    // 控制字符（除制表、换行、回车）
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      return false;
    }
  }
  return true;
}
// 确保路径以斜杠开头
function ensureLeadingSlash(filePath) {
  return filePath.startsWith('/') ? filePath : `/${filePath}`;
}
// 查找入口路径
function findPath(packageData) {
  //检查jsdlivr
  if (packageData.jsdelivr) {
    return ensureLeadingSlash(packageData.jsdelivr);
  }
  // 检查 exports 字段
  if (packageData.exports && packageData.exports['.']) {
    const exportsValue = packageData.exports['.']; //传递'.'

    if (typeof exportsValue === 'string') {
      return ensureLeadingSlash(exportsValue);
    }

    if (typeof exportsValue === 'object' && exportsValue !== null) {
      if (exportsValue.default) {
        return ensureLeadingSlash(exportsValue.default);
      }
    }
  }
  //检查main
  if (packageData.main) {
    return ensureLeadingSlash(packageData.main);
  }
  //都没有的情况
  throw new Error("404 Not Found");
}
// 从 tarball 获取文件内容
async function getFileContent(tarballUrl, filePath) {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Tarball download failed: ${response.status}`);
  }

  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let found = false;
    const chunks = [];
    //创建解析流对象，配置解析逻辑
    const extractor = tar.list({
      onentry: (entry) => {//onentry是一个list属性，entry是匿名函数的参数对象（读取流）
        const rawEntryPath = entry.path;
        let entryPath = rawEntryPath;
        //entry中包含了属性path,type,size,mode(权限),mtime(最后修改时间),uid/gid,uname,gname,linknanme
        // 正确处理 npm tarball 的路径格式
        if (rawEntryPath.startsWith('package/')) {
          entryPath = '/' + rawEntryPath.substring(8);
        } else {
          entryPath = ensureLeadingSlash(rawEntryPath);
        }

        if (entryPath === filePath) {
          found = true;
          entry.on('data', chunk => chunks.push(chunk));//读取
          entry.on('end', () => resolve(Buffer.concat(chunks)));//合并返回
          //流事件的回调函数无法直接使用awiat，需要用promise封装
        } else {
          entry.resume(); // 忽略非目标文件
        }
      }
    });

    extractor.on('error', reject);
    extractor.on('end', () => {
      if (!found) reject(new Error(`File not found: ${filePath}`));
    });
    //创建管道，开始处理数据流
    pipeline(
      Readable.from(response.body),
      gunzip,
      extractor
    ).catch(reject);
  });
}
//获取目录文件列表(相对路径数组)
async function getDirectoryListing(tarballUrl) {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Tarball download failed: ${response.status}`);
  }
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const fileList = [];
    const regex = /^\/[^\/]*$/;
    const extractor = tar.list({
      onentry: (entry) => {
        const rawEntryPath = entry.path;
        let entryPath = rawEntryPath;//临时数据，使用副本，避免修改原始数据
        if (rawEntryPath.startsWith('package/')) {
          entryPath = '/' + rawEntryPath.substring(8);
        } else {
          entryPath = ensureLeadingSlash(rawEntryPath);
        }

        // 只收集文件路径，忽略目录
        if (entry.type === 'File' && regex.test(entryPath)) {

          fileList.push(entryPath);
        }

        entry.resume(); // 忽略文件内容
      }
    });

    extractor.on('error', reject);
    extractor.on('end', () => resolve(fileList));

    pipeline(
      Readable.from(response.body),
      gunzip,
      extractor
    ).catch(reject);
  });
}

//生成目录列表HTML
function generateDirectoryListing(packageName, version, fileList) {
  const title = `${packageName}@${version}`;
  const items = fileList.map(file => {//map相当于一个for的遍历，更为简洁，返回一个新数组
    // 文件路径去掉开头的斜杠
    const fileName = file.startsWith('/') ? file.substring(1) : file;
    return `<li><a href="${fileName}">${fileName}</a></li>`;
  }).join('\n');
  return `<!DOCTYPE HTML>
<html>
<head>
<meta charset="utf-8">
<title>BYR_Achieve</title>
</head>
<body>
<h1>${title}</h1>
<hr>
<ul>
${items}
</ul>
<hr>
</body>
</html>`;
}
//获取版本列表并查找版本
async function findversion(packageName, version_require) {
  const Url = `${REGISTRY}/${encodeURIComponent(packageName)}`;//每个版本的package合体json
  try{
  const response = await fetch(Url);
  if (!response.ok) {//响应验证
      throw new Error(`Registry request failed: ${response.status}`);
    }
  const data = await response.json();
  if (!data || !data.versions) {//存在？
      throw new Error(`Invalid package data: versions field missing`);
    }
  const versions = Object.keys(data.versions);//获取版本列表
  let version = semver.maxSatisfying(versions, version_require);//尝试直接匹配
  if (!version) {//tag(特殊版本解析)
    version = data['dist-tags']?.[version_require] || ' ';
    if (!version) {//没有匹配的版本
      console.log('Not version');
      throw new error('Not version');
    };
  };
  version = semver.maxSatisfying(versions, version);
  return version;
}catch(err){

}
}
const server = http.createServer(async (req, res) => {
  const reqpath = req.url;//获取资源路径
  //访问https://registry.npmjs.org/包名，返回所有版本的package
  // 处理根路径请求
  if (reqpath === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h1>Welcome to BYR jsDlivr</h1>');
  }

  // 解析URL
  const match = reqpath.match(/^\/(?:npm\/)?((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/);
  //正则匹配路径
  if (!match) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const packageName = match[1];
  const version_require = match[2] || 'latest';
  console.log(`version_require:${version_require}`);
  const filePath = match[3] || ''; // 确保有默认值
  console.log(`match[3].filePath:${filePath}`);

  //版本识别
  const version = await findversion(packageName, version_require);
  console.log(`version:${version}`);
  try {//路径请求处理
    const registryUrl = `${REGISTRY}/${encodeURIComponent(packageName)}/${version}`;
    console.log(`查询: ${registryUrl}`);
    const response = await fetch(registryUrl);// 获取元数据
    const packageData = await response.json();
    const tarballUrl = packageData.dist?.tarball || '';
    if (tarballUrl) {
      // 有效下载地址处理
      console.log(`tarballUrl:${packageData.dist.tarball}`);
    } else {
      console.error("No tarballUrl");
      throw new Error("404 Not Found");
    }
    /*三种输入1、/包名或者/包名@版本√
    2、/包名/（返回目录）√
    3、/包名@版本/文件路径文件名√*/
    if (filePath && filePath !== '/') {
      // 处理特定文件请求
      const fileContent = await getFileContent(tarballUrl, filePath);//获取内容
      const contentType = detectFileTypeByBuffer(fileContent);//确定类型
      const contentcharset=jschardet.detect(fileContent);//确认编码
      console.log(`访问特定文件,文件包内路径: ${filePath}`);
      // 设置响应头
      res.writeHead(200, {
        'Content-Type': `${contentType}; charset=${contentcharset}`,
        'Cache-Control': 'public, max-age=86400' // 添加缓存控制
      });
      return res.end(fileContent);
    } else {
      if (!response.ok) {
        throw new Error(`Registry request failed: ${response.status}`);
      }
      //返回目录界面
      if (filePath === '/') {
        const fileList = await getDirectoryListing(tarballUrl);
        const html = generateDirectoryListing(packageName, version, fileList);
        res.writeHead(200, {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'public, max-age=86400' // 添加缓存控制
        });
        return res.end(html);
      }
      //处理包名
      const packageFilePath = findPath(packageData); //寻找路径
      console.log(`packageFilePath: ${packageFilePath}`);
      const fileContent = await getFileContent(tarballUrl, packageFilePath);//获取内容
      const contentType = detectFileTypeByBuffer(fileContent);//获取类型
      const contentcharset=jschardet.detect(fileContent);//确认编码
      // 发送JSON响应
      res.writeHead(200, {
        'Content-Type': `${contentType}; charset=${contentcharset}`,
        'Cache-Control': 'public, max-age=86400' // 添加缓存控制
      });
      res.end(fileContent);
    }

  } catch (err) {
    // 根据错误类型设置不同的状态码
    if (err.message.includes('request failed')) {
      res.writeHead(504, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      return res.end('Registry service unavailable');
    }
    if (err.message.includes('404')) {
      res.writeHead(404);
      return res.end('404 Not found');
    }
    res.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end(`Error: ${err.message}`);
  }
});

server.listen(3000, () => {
  console.log('服务器启动在 http://localhost:3000');
});
