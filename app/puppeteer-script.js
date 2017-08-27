const async = require('async');
const fs = require('fs');
const path = require('path');
const util = require('util');
const puppeteer = require('puppeteer');
const EventEmitter = require('events');

const readFile = util.promisify(fs.readFile);

// 60s timeout on this script
setTimeout(function() {
    console.log('Global timeout (60s per page) has expired.');
    return process.exit(1);
}, 60 * 1000);

// Configuration
const maxTries   = 50;
const tryTimeout = 100;
const maxTimeout = maxTries * tryTimeout;


/**
 * Puppeteer script
 */

module.exports = class Browser extends EventEmitter {

    async init() {
        this.browser = await puppeteer.launch({ headless: true });
    }



    /*
    **  Open a page and run the tasks for each component
    */

    async page(url, settings) {

        const { size, basePath, pageBase, components, delayMs, delayScript, userScript, userPage } = settings;
        const [ width, height ] = size;

        const page = await this.browser.newPage();
        await page.setViewport({ width, height });

        try {
            await page.goto(url);
        } catch(ex) {
            throw new Error(`Unable to load the address « ${url} » (${ex})`);
        }

        // Wait-for-delay
        const delay = this.getWaitForDelay(delayMs, userPage, components);
        await page.waitFor(delay);

        // Wait-for-script
        const waitForScriptFunctions = await this.getUserScriptFunctions(delayScript, userPage, components, basePath, 'wait-for-script');

        try {
            await this.waitForFunctions(waitForScriptFunctions, page);
        } catch(ex) {
            throw new Error(`« wait-for-script » failed to get a truthy response from all scripts. (${ex})`);
        }

        // Run-script
        const runScriptFunctions = await this.getUserScriptFunctions(userScript, userPage, components, basePath, 'run-script');

        await this.executeUserFunctions(runScriptFunctions, page);

        // Loop over components
        await Promise.all(components.map(async component => {

            try {
                await page.waitForSelector(component.selector, { timeout: maxTimeout });
            } catch(ex) {
                throw new Error(`Waiting for selector « ${component.selector} » timed out for « ${component.name} »`);
            }

            // Get handle on component element
            const elHandle = await page.$(component.selector);

            // Hide ignored elements
            await this.ignore(elHandle, component);

            // Clip
            const clip = await this.clip(elHandle);

            // Screenshot
            await page.screenshot({ path: `${pageBase}/${component.name}.png`, clip });

        }));

        await page.close();
        return true;
    }



    /*
    **  Ignore elements
    */

    async ignore(elHandle, component) {

        if(!component.ignore || !component.ignore.length) return;

        await elHandle.evaluate(async (element, componentSelector, ignore) => {
            ignore.forEach(ignoreSelector => {
                const els = [...element.querySelectorAll(ignoreSelector)];
                els.forEach(el => el.style.visibility = 'hidden');
            });
        }, component.selector, component.ignore);
    }



    /*
    **  Clip component
    */

    async clip(elHandle) {

        return await elHandle.evaluate(async element => {
            const b = element.getBoundingClientRect();
            const bounds = { x: b.left, y: b.top, width: b.width, height: b.height };
            return Promise.resolve(bounds);
        });
    }



    /*
    **  Wait for delay
    */

    getWaitForDelay(delayMs, userPage, components) {

        const delays = [delayMs, userPage['wait-for-delay'], ...components.map(c => c['wait-for-delay'])]
            .filter(x => x); // Clean empty values

        return Math.max.apply(null, delays);
    }



    /*
    **  Wait for functions – each must return a truthy value in order to continue
    */

    async waitForFunctions(funcs, page) {

        for(const func of funcs) {
            try {
                await page.waitForFunction(func, { timeout: maxTimeout });
            } catch(ex) {
                throw new Error('…');
            }
        }
    }



    /*
    **  Execute user functions
    */

    async executeUserFunctions(funcs, page) {

        for(const func in funcs) {
            try {
                await page.evaluate(func);
            } catch(ex) {
                throw new Error('…');
            }
        }
    }



    /*
    **  Collect userscript functions
    */

    async getUserScriptFunctions(globalScript, userPage, components, basePath, field) {

        const sources = [globalScript, userPage[field], ...components.map(c => c[field])]
            .filter(x => x); // Clean empty values

        const funcs = await Promise.all(sources.map(async userPath => {

            let absPath = userPath;
            if(!path.isAbsolute(absPath)) absPath = basePath + '/' + absPath;

            try {
                return await readFile(absPath, { encoding: 'utf-8' });
            } catch(ex) {
                throw new Error(`Could not read file: ${userPath}`);
            }
        }));

        return funcs.map(f => new Function(f));
    }
};




/**
 * Run a user script
 */
function runUserScript(cb) {

    if (userScript) {
        _callUserScript(userScript)();
    }
    if (userPage['run-script']) {
        _callUserScript(userPage['run-script'])();
    }
    components.forEach(function(component) {
        if (component['run-script']) {
            _callUserScript(component['run-script'])();
        }
    });

    cb();
}


/**
 * Call a user script inside a function
 *
 * @private
 * @param {String} scriptFilename
 * @returns {Function}
 */
function _callUserScript(scriptFilename) {

    var scriptPath = scriptFilename;
    if (!fs.isAbsolute(scriptPath)) {
        scriptPath = basePath + '/' + scriptPath;
    }

    try {
        var script = fs.read(scriptPath);
    } catch (e) {
        console.log('Could not read file: ' + scriptFilename);
        phantom.exit(1);
    }

    return function() {
        return page.evaluate(function(script) {
            return (Function(script))();
        }, script);
    };
}
