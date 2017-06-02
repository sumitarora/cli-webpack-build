"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ignoreDep @angular/compiler-cli
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const SourceMap = require("source-map");
const { __NGTOOLS_PRIVATE_API_2 } = require('@angular/compiler-cli');
const ContextElementDependency = require('webpack/lib/dependencies/ContextElementDependency');
const resource_loader_1 = require("./resource_loader");
const compiler_host_1 = require("./compiler_host");
const entry_resolver_1 = require("./entry_resolver");
const paths_plugin_1 = require("./paths-plugin");
const lazy_routes_1 = require("./lazy_routes");
const inlineSourceMapRe = /\/\/# sourceMappingURL=data:application\/json;base64,([\s\S]+)$/;
class AotPlugin {
    constructor(options) {
        this._lazyRoutes = Object.create(null);
        this._compiler = null;
        this._compilation = null;
        this._typeCheck = true;
        this._skipCodeGeneration = false;
        this._diagnoseFiles = {};
        this._firstRun = true;
        this._options = Object.assign({}, options);
        this._setupOptions(this._options);
    }
    get options() { return this._options; }
    get basePath() { return this._basePath; }
    get compilation() { return this._compilation; }
    get compilerHost() { return this._compilerHost; }
    get compilerOptions() { return this._compilerOptions; }
    get done() { return this._donePromise; }
    get entryModule() {
        const splitted = this._entryModule.split('#');
        const path = splitted[0];
        const className = splitted[1] || 'default';
        return { path, className };
    }
    get genDir() { return this._genDir; }
    get program() { return this._program; }
    get skipCodeGeneration() { return this._skipCodeGeneration; }
    get typeCheck() { return this._typeCheck; }
    get i18nFile() { return this._i18nFile; }
    get i18nFormat() { return this._i18nFormat; }
    get locale() { return this._locale; }
    get firstRun() { return this._firstRun; }
    _setupOptions(options) {
        // Fill in the missing options.
        if (!options.hasOwnProperty('tsConfigPath')) {
            throw new Error('Must specify "tsConfigPath" in the configuration of @ngtools/webpack.');
        }
        // TS represents paths internally with '/' and expects the tsconfig path to be in this format
        this._tsConfigPath = options.tsConfigPath.replace(/\\/g, '/');
        // Check the base path.
        const maybeBasePath = path.resolve(process.cwd(), this._tsConfigPath);
        let basePath = maybeBasePath;
        if (fs.statSync(maybeBasePath).isFile()) {
            basePath = path.dirname(basePath);
        }
        if (options.hasOwnProperty('basePath')) {
            basePath = path.resolve(process.cwd(), options.basePath);
        }
        const configResult = ts.readConfigFile(this._tsConfigPath, ts.sys.readFile);
        if (configResult.error) {
            const diagnostic = configResult.error;
            const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            throw new Error(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message})`);
        }
        const tsConfigJson = configResult.config;
        if (options.hasOwnProperty('compilerOptions')) {
            tsConfigJson.compilerOptions = Object.assign({}, tsConfigJson.compilerOptions, options.compilerOptions);
        }
        // Default exclude to **/*.spec.ts files.
        if (!options.hasOwnProperty('exclude')) {
            options['exclude'] = ['**/*.spec.ts'];
        }
        // Add custom excludes to default TypeScript excludes.
        if (options.hasOwnProperty('exclude')) {
            // If the tsconfig doesn't contain any excludes, we must add the default ones before adding
            // any extra ones (otherwise we'd include all of these which can cause unexpected errors).
            // This is the same logic as present in TypeScript.
            if (!tsConfigJson.exclude) {
                tsConfigJson['exclude'] = ['node_modules', 'bower_components', 'jspm_packages'];
                if (tsConfigJson.compilerOptions && tsConfigJson.compilerOptions.outDir) {
                    tsConfigJson.exclude.push(tsConfigJson.compilerOptions.outDir);
                }
            }
            // Join our custom excludes with the existing ones.
            tsConfigJson.exclude = tsConfigJson.exclude.concat(options.exclude);
        }
        const tsConfig = ts.parseJsonConfigFileContent(tsConfigJson, ts.sys, basePath, null, this._tsConfigPath);
        let fileNames = tsConfig.fileNames;
        this._rootFilePath = fileNames;
        // Check the genDir. We generate a default gendir that's under basepath; it will generate
        // a `node_modules` directory and because of that we don't want TypeScript resolution to
        // resolve to that directory but the real `node_modules`.
        let genDir = path.join(basePath, '$$_gendir');
        this._compilerOptions = tsConfig.options;
        this._angularCompilerOptions = Object.assign({ genDir }, this._compilerOptions, tsConfig.raw['angularCompilerOptions'], { basePath });
        if (this._angularCompilerOptions.hasOwnProperty('genDir')) {
            genDir = path.resolve(basePath, this._angularCompilerOptions.genDir);
            this._angularCompilerOptions.genDir = genDir;
        }
        this._basePath = basePath;
        this._genDir = genDir;
        if (options.hasOwnProperty('typeChecking')) {
            this._typeCheck = options.typeChecking;
        }
        if (options.hasOwnProperty('skipCodeGeneration')) {
            this._skipCodeGeneration = options.skipCodeGeneration;
        }
        this._compilerHost = new compiler_host_1.WebpackCompilerHost(this._compilerOptions, this._basePath);
        // Override some files in the FileSystem.
        if (options.hasOwnProperty('hostOverrideFileSystem')) {
            for (const filePath of Object.keys(options.hostOverrideFileSystem)) {
                this._compilerHost.writeFile(filePath, options.hostOverrideFileSystem[filePath], false);
            }
        }
        // Override some files in the FileSystem with paths from the actual file system.
        if (options.hasOwnProperty('hostReplacementPaths')) {
            for (const filePath of Object.keys(options.hostReplacementPaths)) {
                const replacementFilePath = options.hostReplacementPaths[filePath];
                const content = this._compilerHost.readFile(replacementFilePath);
                this._compilerHost.writeFile(filePath, content, false);
            }
        }
        this._program = ts.createProgram(this._rootFilePath, this._compilerOptions, this._compilerHost);
        // We enable caching of the filesystem in compilerHost _after_ the program has been created,
        // because we don't want SourceFile instances to be cached past this point.
        this._compilerHost.enableCaching();
        if (options.entryModule) {
            this._entryModule = options.entryModule;
        }
        else if (tsConfig.raw['angularCompilerOptions']
            && tsConfig.raw['angularCompilerOptions'].entryModule) {
            this._entryModule = path.resolve(this._basePath, tsConfig.raw['angularCompilerOptions'].entryModule);
        }
        // still no _entryModule? => try to resolve from mainPath
        if (!this._entryModule && options.mainPath) {
            const mainPath = path.resolve(basePath, options.mainPath);
            this._entryModule = entry_resolver_1.resolveEntryModuleFromMain(mainPath, this._compilerHost, this._program);
        }
        if (options.hasOwnProperty('i18nFile')) {
            this._i18nFile = options.i18nFile;
        }
        if (options.hasOwnProperty('i18nFormat')) {
            this._i18nFormat = options.i18nFormat;
        }
        if (options.hasOwnProperty('locale')) {
            this._locale = options.locale;
        }
    }
    _findLazyRoutesInAst() {
        const result = Object.create(null);
        const changedFilePaths = this._compilerHost.getChangedFilePaths();
        for (const filePath of changedFilePaths) {
            const fileLazyRoutes = lazy_routes_1.findLazyRoutes(filePath, this._program, this._compilerHost);
            for (const routeKey of Object.keys(fileLazyRoutes)) {
                const route = fileLazyRoutes[routeKey];
                if (routeKey in this._lazyRoutes) {
                    if (route === null) {
                        this._lazyRoutes[routeKey] = null;
                    }
                    else if (this._lazyRoutes[routeKey] !== route) {
                        this._compilation.warnings.push(new Error(`Duplicated path in loadChildren detected during a rebuild. `
                            + `We will take the latest version detected and override it to save rebuild time. `
                            + `You should perform a full build to validate that your routes don't overlap.`));
                    }
                }
                else {
                    result[routeKey] = route;
                }
            }
        }
        return result;
    }
    // registration hook for webpack plugin
    apply(compiler) {
        this._compiler = compiler;
        compiler.plugin('invalid', () => {
            // Turn this off as soon as a file becomes invalid and we're about to start a rebuild.
            this._firstRun = false;
            this._diagnoseFiles = {};
            if (compiler.watchFileSystem.watcher) {
                compiler.watchFileSystem.watcher.once('aggregated', (changes) => {
                    changes.forEach((fileName) => this._compilerHost.invalidate(fileName));
                });
            }
        });
        // Add lazy modules to the context module for @angular/core/src/linker
        compiler.plugin('context-module-factory', (cmf) => {
            const angularCorePackagePath = require.resolve('@angular/core/package.json');
            const angularCorePackageJson = require(angularCorePackagePath);
            const angularCoreModulePath = path.resolve(path.dirname(angularCorePackagePath), angularCorePackageJson['module']);
            // Pick the last part after the last node_modules instance. We do this to let people have
            // a linked @angular/core or cli which would not be under the same path as the project
            // being built.
            const angularCoreModuleDir = path.dirname(angularCoreModulePath).split(/node_modules/).pop();
            cmf.plugin('after-resolve', (result, callback) => {
                if (!result) {
                    return callback();
                }
                // Alter only request from Angular;
                //   @angular/core/src/linker matches for 2.*.*,
                //   The other logic is for flat modules and requires reading the package.json of angular
                //     (see above).
                if (!result.resource.endsWith(path.join('@angular/core/src/linker'))
                    && (angularCoreModuleDir && !result.resource.endsWith(angularCoreModuleDir))) {
                    return callback(null, result);
                }
                this.done.then(() => {
                    result.resource = this.skipCodeGeneration ? this.basePath : this.genDir;
                    result.recursive = true;
                    result.dependencies.forEach((d) => d.critical = false);
                    result.resolveDependencies = (_fs, _resource, _recursive, _regExp, cb) => {
                        const dependencies = Object.keys(this._lazyRoutes)
                            .map((key) => {
                            const value = this._lazyRoutes[key];
                            if (value !== null) {
                                return new ContextElementDependency(value, key);
                            }
                            else {
                                return null;
                            }
                        })
                            .filter(x => !!x);
                        cb(null, dependencies);
                    };
                    return callback(null, result);
                }, () => callback(null))
                    .catch(err => callback(err));
            });
        });
        compiler.plugin('make', (compilation, cb) => this._make(compilation, cb));
        compiler.plugin('after-emit', (compilation, cb) => {
            this._donePromise = null;
            this._compilation = null;
            compilation._ngToolsWebpackPluginInstance = null;
            cb();
        });
        compiler.plugin('after-resolvers', (compiler) => {
            // Virtual file system.
            compiler.resolvers.normal.plugin('before-resolve', (request, cb) => {
                if (request.request.match(/\.ts$/)) {
                    this.done.then(() => cb(), () => cb());
                }
                else {
                    cb();
                }
            });
            compiler.resolvers.normal.apply(new paths_plugin_1.PathsPlugin({
                tsConfigPath: this._tsConfigPath,
                compilerOptions: this._compilerOptions,
                compilerHost: this._compilerHost
            }));
        });
    }
    _translateSourceMap(sourceText, fileName, { line, character }) {
        const match = sourceText.match(inlineSourceMapRe);
        if (!match) {
            return { line, character, fileName };
        }
        // On any error, return line and character.
        try {
            const sourceMapJson = JSON.parse(Buffer.from(match[1], 'base64').toString());
            const consumer = new SourceMap.SourceMapConsumer(sourceMapJson);
            const original = consumer.originalPositionFor({ line, column: character });
            return {
                line: typeof original.line == 'number' ? original.line : line,
                character: typeof original.column == 'number' ? original.column : character,
                fileName: original.source || fileName
            };
        }
        catch (e) {
            return { line, character, fileName };
        }
    }
    diagnose(fileName) {
        if (this._diagnoseFiles[fileName]) {
            return;
        }
        this._diagnoseFiles[fileName] = true;
        const sourceFile = this._program.getSourceFile(fileName);
        if (!sourceFile) {
            return;
        }
        const diagnostics = []
            .concat(this._program.getCompilerOptions().declaration
            ? this._program.getDeclarationDiagnostics(sourceFile) : [], this._program.getSyntacticDiagnostics(sourceFile), this._program.getSemanticDiagnostics(sourceFile));
        if (diagnostics.length > 0) {
            diagnostics.forEach(diagnostic => {
                const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                const sourceText = diagnostic.file.getFullText();
                let { line, character, fileName } = this._translateSourceMap(sourceText, diagnostic.file.fileName, position);
                const messageText = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
                const message = `${fileName} (${line + 1},${character + 1}): ${messageText}`;
                switch (diagnostic.category) {
                    case ts.DiagnosticCategory.Error:
                        this._compilation.errors.push(message);
                        break;
                    default:
                        this._compilation.warnings.push(message);
                }
            });
        }
    }
    _make(compilation, cb) {
        this._compilation = compilation;
        if (this._compilation._ngToolsWebpackPluginInstance) {
            return cb(new Error('An @ngtools/webpack plugin already exist for this compilation.'));
        }
        this._compilation._ngToolsWebpackPluginInstance = this;
        this._resourceLoader = new resource_loader_1.WebpackResourceLoader(compilation);
        this._donePromise = Promise.resolve()
            .then(() => {
            if (this._skipCodeGeneration) {
                return;
            }
            // Create the Code Generator.
            return __NGTOOLS_PRIVATE_API_2.codeGen({
                basePath: this._basePath,
                compilerOptions: this._compilerOptions,
                program: this._program,
                host: this._compilerHost,
                angularCompilerOptions: this._angularCompilerOptions,
                i18nFile: this.i18nFile,
                i18nFormat: this.i18nFormat,
                locale: this.locale,
                readResource: (path) => this._resourceLoader.get(path)
            });
        })
            .then(() => {
            // Get the ngfactory that were created by the previous step, and add them to the root
            // file path (if those files exists).
            const newRootFilePath = this._compilerHost.getChangedFilePaths()
                .filter(x => x.match(/\.ngfactory\.ts$/));
            // Remove files that don't exist anymore, and add new files.
            this._rootFilePath = this._rootFilePath
                .filter(x => this._compilerHost.fileExists(x))
                .concat(newRootFilePath);
            // Create a new Program, based on the old one. This will trigger a resolution of all
            // transitive modules, which include files that might just have been generated.
            // This needs to happen after the code generator has been created for generated files
            // to be properly resolved.
            this._program = ts.createProgram(this._rootFilePath, this._compilerOptions, this._compilerHost, this._program);
        })
            .then(() => {
            // Re-diagnose changed files.
            const changedFilePaths = this._compilerHost.getChangedFilePaths();
            changedFilePaths.forEach(filePath => this.diagnose(filePath));
        })
            .then(() => {
            if (this._typeCheck) {
                const diagnostics = this._program.getGlobalDiagnostics();
                if (diagnostics.length > 0) {
                    const message = diagnostics
                        .map(diagnostic => {
                        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
                        return `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message})`;
                    })
                        .join('\n');
                    throw new Error(message);
                }
            }
        })
            .then(() => {
            // Populate the file system cache with the virtual module.
            this._compilerHost.populateWebpackResolver(this._compiler.resolvers.normal);
        })
            .then(() => {
            // We need to run the `listLazyRoutes` the first time because it also navigates libraries
            // and other things that we might miss using the findLazyRoutesInAst.
            let discoveredLazyRoutes = this.firstRun ?
                __NGTOOLS_PRIVATE_API_2.listLazyRoutes({
                    program: this._program,
                    host: this._compilerHost,
                    angularCompilerOptions: this._angularCompilerOptions,
                    entryModule: this._entryModule
                })
                : this._findLazyRoutesInAst();
            // Process the lazy routes discovered.
            Object.keys(discoveredLazyRoutes)
                .forEach(k => {
                const lazyRoute = discoveredLazyRoutes[k];
                k = k.split('#')[0];
                if (lazyRoute === null) {
                    return;
                }
                if (this.skipCodeGeneration) {
                    this._lazyRoutes[k] = lazyRoute;
                }
                else {
                    const factoryPath = lazyRoute.replace(/(\.d)?\.ts$/, '.ngfactory.ts');
                    const lr = path.relative(this.basePath, factoryPath);
                    this._lazyRoutes[k + '.ngfactory'] = path.join(this.genDir, lr);
                }
            });
        })
            .then(() => {
            if (this._compilation.errors == 0) {
                this._compilerHost.resetChangedFileTracker();
            }
            cb();
        }, (err) => {
            compilation.errors.push(err);
            cb();
        });
    }
}
exports.AotPlugin = AotPlugin;
//# sourceMappingURL=/private/var/folders/70/r7lbk4zj0t791wwf4lxrn87c0000gn/t/angular-cli-builds11752-80737-h4wwoz.f35tye3ik9/angular-cli/src/plugin.js.map