const argumentLoader = require('./cli/argumentLoader');
const userCfgLoader  = require('./cli/userConfigLoader');
const log            = require('./log');
const util           = require('./util');
const async          = require('async');
const child_process  = require('child_process');
const fs             = require('fs');
const path           = require('path');
// const phantomjsPath  = require('phantomjs-prebuilt').path;
const Browser        = require('./puppeteer-script');
const rimraf         = require('rimraf').sync;

const browser = new Browser();

/**
 * Action `capture`
 *  Captures screenshots for all pages & components specified in `config`
 *
 * @param {String} id - The identifier for this set of screenshots
 * @param {Function} cb - The callback function, returns a boolean representing success
 * @returns {Boolean}
 */
module.exports = async function capture(id, cb) {

    await browser.init();

    var config = argumentLoader.getConfig();
    var userConfig = userCfgLoader.getUserConfig();

    var baseDir = config.base + '/' + id;
    if (util.directoryExists(baseDir)) {
        rimraf(baseDir);
    }

    log.verbose(util.format('Using a Puppeteer concurrency of %s', config.concurrency));
    log.verbose(util.format('Found %d size%s, %d page%s and %d component%s',
        userConfig.sizes.length,
        util.plural(userConfig.sizes.length),
        userConfig.pages.length,
        util.plural(userConfig.pages.length),
        userConfig.components.length,
        util.plural(userConfig.components.length)));

    var q = async.queue(createWorker(config, userConfig, baseDir), config.concurrency);

    var shots = 0, failed = 0;

    userConfig.sizes.forEach(size =>
        userConfig.pages.forEach(page =>
            q.push({ size, page }, (err, res) => {
                shots += res.shots;
                failed += res.failed;
            })));

    q.drain = function() {

        util.removeEmptyDirectories(baseDir);

        log.success(util.format('Saved %d screenshot%s in: %s/%s',
            shots,
            util.plural(shots),
            path.relative(process.cwd(), config.base),
            id));

        if (failed > 0) {
            log.warning(util.format('Failed to take %d sceenshot%s', failed, util.plural(failed)));
        }

        cb(failed === 0);
    };
};

/**
 * Creates a queue worker
 *
 * @param {{}} config
 * @param {UserConfig} userConfig
 * @param {String} baseDir
 * @returns {Function}
 */
function createWorker(config, userConfig, baseDir) {
    return function(task, cb) {
        return queueWorker(config, userConfig, baseDir, task, cb);
    }
}

/**
 * The worker itself
 *
 * @param {{}} config
 * @param {UserConfig} userConfig
 * @param {String} baseDir
 * @param {{ size: String, page: { name: String, url: String, components: String[] } }} task
 * @param {Function} cb
 * @returns {{ shots: Number, failed: Number }} - The number of captures taken and failed.
 */
async function queueWorker(config, userConfig, baseDir, task, cb) {

    var prefixSize = str => util.prefixStdStream('[' + task.size + '] ', str);
    var prefixPage = str => util.prefixStdStream('[page: ' + task.page.name + '] ', str);
    var logPrefix  = str => prefixPage(prefixSize(str));

    var pageBase = baseDir + '/' + task.size + '/' + task.page.name;
    util.mkdir(pageBase);

    log.verbose(logPrefix(util.format('Starting Puppeteer')));

    var components = task.page.components.map(componentId =>
        userConfig.components.find(component => component.name === componentId));

    try {
        await browser.page(task.page.url, {
            basePath: path.dirname(config.config),
            pageBase,
            size: task.size.split('x').map(x => parseInt(x, 10)),
            userPage: task.page,
            components,
            delayScript: userConfig['wait-for-script'] || '',
            delayMs: parseInt(userConfig['wait-for-delay'], 10) || 0,
            userScript: userConfig['run-script'] || '',
            credentials: (userConfig['credentials'] || '').split(':')
        });
    } catch(ex) {
        return console.error(`Browser#newPage error: ${ex}`);
    }

    // Process finished
    var shots = 0, failed = 0;

    // Check existence of all .png files
    var tasks = task.page.components.map(componentId => {
        return cb => {
            var pngfile = pageBase + '/' + componentId + '.png';
            util.fileExistsAsync(pngfile, (err, exists) => {
                if (!err && exists) {
                    shots++;
                } else {
                    failed++;
                    log.error(logPrefix(util.format( "Puppeteer errored for component '%s'", componentId)));
                }
                cb();
            });
        };
    });

    async.parallel(tasks, () => {
        log.verbose(logPrefix(util.format('Puppeteer captured %d components', shots)));
        cb(null, { shots, failed });
        cb = () => {};
    });

    return;

    // Report errors if we're still here
    log.error(util.format("Puppeteer errored for page: '%s'", task.page.name));

    cb(null, { shots: 0, failed: task.page.components.length });
    cb = () => {};

}
