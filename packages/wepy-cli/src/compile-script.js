import path from 'path';
import util from './util';
import cache from './cache';
import cWpy from './compile-wpy';

import loader from './loader';

import resolve from './resolve';


const currentPath = util.currentDir;

let appPath,
  npmPath,
  src,
  dist;

// tuhu包相关
const tuhuNpmPackageDir = 'We_App_Npm'
const tuhuPrivateModulesPath = path.resolve(currentPath, `../${tuhuNpmPackageDir}/`)
// 是否是tuhu私有包
function isTuhuPrivatePackage(lib) {
  return lib.indexOf('@tuhu') === 0 && lib.indexOf('weapp-tuhu') >= 0
}

export default {
  resolveDeps(code, type, opath) {
    let params = cache.getParams();
    let config = cache.getConfig();
    let wpyExt = params.wpyExt;
    let npmInfo = opath.npm;


    return code.replace(/require\(['"]([\w\d_\-\.\/@]+)['"]\)/ig, (match, lib) => {
      // 判断是否是途虎私有包
      let isTuhu = isTuhuPrivatePackage(lib) || type === 'tuhu'
      let nextRequireIsNpm = true // 默认都是npm包
      if (isTuhu) {
        // @tuhu/weapp-tuhu/src/ => weapp-tuhu/src/
        lib = lib.replace('@tuhu/', '')
      }
      let resolved = lib;


      let target = '',
        source = '',
        ext = '',
        needCopy = false;

      if (config.output === 'ant' && lib === 'wepy') {
        lib = 'wepy-ant';
      }
      lib = resolve.resolveAlias(lib);
      if (path.isAbsolute(lib)) {
        source = lib;
        target = util.getDistPath(source);
      } else if (lib[0] === '.') { // require('./something'');
        source = path.join(opath.dir, lib); // e:/src/util
        if (type === 'npm') {
          target = path.join(npmPath, path.relative(npmInfo.modulePath, source));
          needCopy = true;
        } else if (type === 'tuhu') {
          target = path.join(npmPath, path.relative(npmInfo.modulePath, source))
          nextRequireIsNpm = false
          needCopy = true;
        } else {
          // e:/dist/util
          target = util.getDistPath(source);
          needCopy = false;
        }
      } else if (lib.indexOf('/') === -1 || // require('asset');
        lib.indexOf('/') === lib.length - 1 || // reqiore('a/b/something/')
        (lib[0] === '@' && lib.indexOf('/') !== -1 && lib.lastIndexOf('/') === lib.indexOf('/')) // require('@abc/something')
      ) {
        let mainFile = resolve.getMainFile(lib);

        if (!mainFile) {
          throw Error('找不到模块: ' + lib + '\n被依赖于: ' + path.join(opath.dir, opath.base) + '。\n请尝试手动执行 npm install ' + lib + ' 进行安装。');
        }
        npmInfo = {
          lib: lib,
          dir: mainFile.dir,
          modulePath: mainFile.modulePath,
          file: mainFile.file,
        };
        source = path.join(mainFile.dir, mainFile.file);
        target = path.join(npmPath, lib, mainFile.file);

        lib += path.sep + mainFile.file;
        ext = '';
        needCopy = true;
      }
      // require('babel-runtime/regenerator')
      // require('@tuhu/weapp-tuhu/lib/fetch')
      else {
        if (isTuhu) {
          source = path.join(tuhuPrivateModulesPath, lib);
          nextRequireIsNpm = false
        } else {
          let o = resolve.walk(lib);
          source = path.join(o.modulePath, lib);
          const modulesDir = path.dirname(source);
          const lastIndex = modulesDir.indexOf('node_modules') + 'node_modules'.length;
          const rootDir = modulesDir.substr(0, lastIndex);
          npmInfo = {
            lib: lib,
            dir: modulesDir,
            modulePath: rootDir,
            file: `${lib}.js`,
          }
        }

        target = path.join(npmPath, lib);
        ext = '';
        needCopy = true;
      }

      if (util.isFile(source + wpyExt)) {
        ext = '.js';
      } else if (util.isFile(source + '.js')) {
        ext = '.js';
      } else if (util.isDir(source) && util.isFile(source + path.sep + 'index.js')) {
        ext = path.sep + 'index.js';
      } else if (util.isFile(source)) {
        ext = '';
      } else {
        throw ('找不到文件: ' + source);
      }
      source += ext;
      target += ext;
      lib += ext;
      resolved = lib;

      // 第三方组件
      if (/\.wpy$/.test(resolved)) {
        target = target.replace(/\.wpy$/, '') + '.js';
        resolved = resolved.replace(/\.wpy$/, '') + '.js';
        lib = resolved;
      }

      if (needCopy) {
        if (!cache.checkBuildCache(source)) {
          cache.setBuildCache(source);
          util.log('依赖: ' + path.relative(process.cwd(), target), '拷贝');
          let newOpath = path.parse(source);
          newOpath.npm = npmInfo;
          const nextIsTuhu = isTuhu && !nextRequireIsNpm
          let compileType = 'js'

          // 配置的需要编译的 npm 包
          const babelNpm = config.includeNpm && config.includeNpm.indexOf(newOpath.name) > -1;

          if (newOpath.base.indexOf('.js') > 0 && (type !== 'npm' || babelNpm)) { // npm类型的不编译
            compileType = 'babel'
          }
          this.compile(compileType, null, nextIsTuhu ? 'tuhu' : 'npm', newOpath);
        }
      }
      if (type === 'npm' || type === 'tuhu') {
        if (lib[0] !== '.') {
          resolved = path.join('..' + path.sep, path.relative(opath.dir, npmInfo.modulePath), lib);
        } else {
          if (lib[0] === '.' && lib[1] === '.') {
            resolved = './' + resolved;
          }
        }
      } else {
        resolved = path.relative(util.getDistPath(opath, opath.ext, src, dist), target);
      }
      resolved = resolved.replace(/\\/g, '/').replace(/^\.\.\//, './');
      return `require('${resolved}')`;
    });
  },

  npmHack(opath, code) {
    // 一些库（redux等） 可能会依赖 process.env.NODE_ENV 进行逻辑判断
    // 这里在编译这一步直接做替换 否则报错
    code = code.replace(/process\.env\.NODE_ENV/g, JSON.stringify(process.env.NODE_ENV));
    switch (opath.base) {
      case 'lodash.js':
      case '_global.js':
        code = code.replace('Function(\'return this\')()', 'this');
        break;
      case '_html.js':
        code = 'module.exports = false;';
        break;
      case '_microtask.js':
        code = code.replace('if(Observer)', 'if(false && Observer)');
        // IOS 1.10.2 Promise BUG
        code = code.replace('Promise && Promise.resolve', 'false && Promise && Promise.resolve');
        break;
      case '_freeGlobal.js':
        code = code.replace('module.exports = freeGlobal;', 'module.exports = freeGlobal || this;')
    }
    let config = util.getConfig();
    if (config.output === 'ant' && opath.dir.substr(-19) === 'wepy-async-function') {
      code = '';
    }
    return code;
  },

  compile(lang, code, type, opath) {
    let config = util.getConfig();

    src = cache.getSrc();
    dist = cache.getDist();
    npmPath = path.join(currentPath, dist, 'npm' + path.sep);

    if (!code) {
      code = util.readFile(path.join(opath.dir, opath.base));
      if (code === null) {
        throw '打开文件失败: ' + path.join(opath.dir, opath.base);
      }
    }

    let compiler = loader.loadCompiler(lang);

    if (!compiler) {
      return;
    }


    compiler(code, config.compilers[lang] || {}).then((compileResult) => {
      let sourceMap;
      if (typeof (compileResult) === 'string') {
        code = compileResult;
      } else {
        sourceMap = compileResult.map;
        code = compileResult.code;
      }
      if (type !== 'npm' || type !== 'tuhu') {
        if (type === 'page' || type === 'app') {
          code = code.replace(/exports\.default\s*=\s*(\w+);/ig, function (m, defaultExport) {
            if (defaultExport === 'undefined') {
              return '';
            }

            if (type === 'page') {
              let pagePath = path.join(path.relative(appPath.dir, opath.dir), opath.name).replace(/\\/ig, '/');
              return `\nPage(require('wepy').default.$createPage(${defaultExport} , '${pagePath}'));\n`;
            } else {
              appPath = opath;
              let appConfig = JSON.stringify(config.appConfig || {});
              return `\nApp(require('wepy').default.$createApp(${defaultExport}, ${appConfig}));\n`;
            }
          });
        }
      }

      code = this.resolveDeps(code, type, opath);

      if (type === 'npm' && opath.ext === '.wpy') { // 第三方npm组件，后缀恒为wpy
        cWpy.compile(opath);
        return;
      }

      let target;
      if (type !== 'npm' && type !== 'tuhu') {
        target = util.getDistPath(opath, 'js');
      } else {
        if (type === 'tuhu') {
          const dir = opath.dir.replace(tuhuNpmPackageDir, `dist${path.sep}npm${path.sep}`)
          target = path.join(npmPath, path.relative(opath.npm.modulePath, path.join(dir, opath.base)));
        } else {
          code = this.npmHack(opath, code);
          target = path.join(npmPath, path.relative(opath.npm.modulePath, path.join(opath.dir, opath.base)));
        }
      }

      if (sourceMap) {
        sourceMap.sources = [opath.name + '.js'];
        sourceMap.file = opath.name + '.js';
        var Base64 = require('js-base64').Base64;
        code += `\r\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Base64.encode(JSON.stringify(sourceMap))}`;
      }

      let plg = new loader.PluginHelper(config.plugins, {
        type: type,
        code: code,
        file: target,
        output(p) {
          util.output(p.action, p.file);
        },
        done(result) {
          util.output('写入', result.file);
          util.writeFile(target, result.code);
        },
      });
      // 缓存文件修改时间戳
      cache.saveBuildCache();
    }).catch((e) => {
      util.error(e);
    });
  },

}
