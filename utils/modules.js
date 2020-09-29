const path     = require('path');
const fs       = require('./fsp');
const utils    = require('./utils');
const NSError  = require('./errors/NSError');
const NSErrors = require('./errors/NSErrors');

let loadedModules;

/**
 * Module : Charge les fonctions dans les init.js des modules si besoin
 */
const modulesLoadFunctions = async (property, params = {}, functionToExecute) => {
    if (global.moduleExtend[property] && typeof global.moduleExtend[property].function === 'function') {
        return global.moduleExtend[property].function(params);
    }
    return functionToExecute();
};

/**
 * Module : Create '\themes\ {theme_name}\modules\list_modules.js'
 */
const createListModuleFile = async (theme = global.envConfig.environment.currentTheme) => {
    let modules_folder = '';
    try {
        modules_folder = path.join(global.appRoot, `themes/${theme}/modules`);
        await fs.ensureDir(modules_folder);
        const isFileExists = await fs.access(`${modules_folder}/list_modules.js`);
        if (!isFileExists) {
            await fs.writeFile(`${modules_folder}/list_modules.js`, 'export default [];');
        }
    } catch (err) {
        console.error(err);
    }
};

/**
 * display all modules installed with the current theme
 * @param {String} theme theme name
 */
const displayListModule = async (theme = global.envConfig.environment.currentTheme) => {
    let modules_folder = '';
    try {
        modules_folder    = `./themes/${theme}/modules`;
        const fileContent = await fs.readFile(`${modules_folder}/list_modules.js`);
        console.log(`%s@@ Theme's module (list_modules.js) : ${fileContent.toString()}%s`, '\x1b[32m', '\x1b[0m');
    } catch (e) {
        console.error('Cannot read list_module !');
    }
};

const errorModule = async (target_path_full) => {
    try {
        await fs.unlink(target_path_full);
    } catch (err) {
        console.error(err);
    }
    const path = target_path_full.replace('.zip', '/');
    try {
        await fs.unlink(path);
    } catch (err) {
        console.error('Error: ', err);
    }
};

const compareDependencies = (myModule, modulesActivated, install = true) => {
    const sameDependencies = {
        api   : {},
        theme : {}
    };
    for (const apiOrTheme of Object.keys(myModule.packageDependencies)) {
        for (const [name, version] of Object.entries(myModule.packageDependencies[apiOrTheme])) {
            if (!sameDependencies[apiOrTheme][name]) {
                sameDependencies[apiOrTheme][name] = install ? new Set() : [];
            }
            if (install) {
                sameDependencies[apiOrTheme][name].add(version);
            } else {
                sameDependencies[apiOrTheme][name].push(version);
            }
            if (modulesActivated.length > 0) {
                for (const elem of modulesActivated) {
                    if (
                        elem.packageDependencies
                        && elem.packageDependencies[apiOrTheme]
                    ) {
                        for (const [name1, version1] of Object.entries(elem.packageDependencies[apiOrTheme])) {
                            if (name1 === name) {
                                if (install) {
                                    sameDependencies[apiOrTheme][name1].add(version1);
                                } else {
                                    sameDependencies[apiOrTheme][name1].push(version1);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return sameDependencies;
};

const checkModuleDepencendiesAtInstallation = async (module) => {
    if (module.moduleDependencies) {
        const missingDependencies = [];
        const needActivation      = [];
        const {Modules}           = require('../orm/models');
        const allmodule           = await Modules.find({}, {name: 1, active: 1});

        for (const elem of module.moduleDependencies) {
            const found = allmodule.find((mod) => mod.name === elem);
            if (!found) {
                missingDependencies.push(elem);
            } else {
                if (!found.active) {
                    needActivation.push(found.name);
                }
            }
        }

        if (missingDependencies.length > 0 || needActivation.length > 0) {
            const error = new NSError(
                NSErrors.MissingModuleDependencies.status,
                NSErrors.MissingModuleDependencies.code
            );
            error.datas = {missingDependencies, needActivation};
            throw error;
        }
    }
};

const checkModuleDepencendiesAtUninstallation = async (myModule) => {
    if (myModule.moduleDependencies) {
        const needDeactivation = [];
        const {Modules}        = require('../orm/models');
        const allmodule        = await Modules.find(
            {$and: [{name: {$ne: myModule.name}}, {active: true}]},
            {name: 1, moduleDependencies: 1}
        );

        for (const elem of allmodule) {
            if (elem.moduleDependencies && elem.moduleDependencies.find((dep) => dep === myModule.name)) {
                needDeactivation.push(elem.name);
            }
        }

        if (needDeactivation.length > 0) {
            const error = new NSError(
                NSErrors.RequiredModuleDependencies.status,
                NSErrors.RequiredModuleDependencies.code
            );
            error.datas = {needDeactivation};
            throw error;
        }
    }
};

/**
 * Module : Charge les fichiers init.js des modules si besoin
 */
const modulesLoadInit = async (express) => {
    const Modules  = require('../orm/models/modules');
    const _modules = await Modules.find({active: true}, {name: 1}).lean();
    loadedModules  = [..._modules];
    loadedModules  = loadedModules.map((lmod) => {return {...lmod, init: true, valid: false};});
    if (loadedModules.length > 0) {
        console.log('Start init loading modules');
        console.log('Required modules :');
    }
    for (let i = 0; i < loadedModules.length; i++) {
        const initModuleFile = path.join(global.appRoot, `/modules/${loadedModules[i].name}/init.js`);
        if (await fs.access(initModuleFile)) {
            process.stdout.write(`- ${loadedModules[i].name}`);
            try {
                const isValid = await utils.checkModuleRegistryKey(loadedModules[i].name);
                if (!isValid) {
                    throw new Error('Error checking licence');
                }
                loadedModules[i].valid = true;
                require(initModuleFile)(express, global.appRoot, global.envFile);
                process.stdout.write('\x1b[32m \u2713 \x1b[0m\n');
            } catch (err) {
                loadedModules[i].init = false;
                process.stdout.write('\x1b[31m \u274C \x1b[0m\n');
                return false;
            }
        }
    }
    if (loadedModules.length > 0) {
        console.log('Finish init loading modules');
    } else {
        console.log('no modules to load');
    }
};

/**
 * Module : Charge les fichiers initAfter.js des modules actifs
 */
const modulesLoadInitAfter = async (apiRouter, server, passport) => {
    loadedModules = loadedModules.filter((mod) => mod.init) || [];
    if (loadedModules.length > 0) {
        console.log('Start initAfter loading modules');
        for (const mod of loadedModules) {
            try {
                // Récupère les fichiers initAfter.js des modules
                await new Promise(async (resolve, reject) => {
                    try {
                        if (await fs.access(path.join(global.appRoot, `/modules/${mod.name}/initAfter.js`))) {
                            process.stdout.write(`- ${mod.name}`);
                            if (!mod.valid) {
                                const isValid = await utils.checkModuleRegistryKey(mod.name);
                                if (!isValid) {
                                    throw new Error('Error checking licence');
                                }
                            }
                            require(path.join(global.appRoot, `/modules/${mod.name}/initAfter.js`))(resolve, reject, server, apiRouter, passport);
                        }
                        resolve();
                    } catch (err) {
                        process.stdout.write('\x1b[31m \u274C \x1b[0m\n');
                        reject(err);
                    }
                });
                process.stdout.write('\x1b[32m \u2713 \x1b[0m\n');
            } catch (err) {
                console.error(err);
            }
        }
        loadedModules = undefined;
        console.log('Finish initAfter loading modules');
    }
};

module.exports = {
    modulesLoadFunctions,
    createListModuleFile,
    displayListModule,
    errorModule,
    compareDependencies,
    checkModuleDepencendiesAtInstallation,
    checkModuleDepencendiesAtUninstallation,
    modulesLoadInit,
    modulesLoadInitAfter
};