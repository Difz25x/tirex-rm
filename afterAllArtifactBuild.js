// This hook runs after electron-builder creates all artifacts (exe, blockmap, latest.yml)
// It creates update-pack.zip containing the source files for hot-updates
// and returns its path so electron-builder publishes it alongside the exe.

const path = require("path");
const fs = require("fs");
const AdmZip = require("adm-zip");

const UPDATABLE_FILES = [
    "index.html",
    "styles.css",
    "main.js",
    "updater.js",
    "package.json",
    "js/shared.js",
    "js/notifications.js",
    "js/console.js",
    "js/accounts.js",
    "js/servers.js",
    "js/instances.js",
    "js/fflags.js",
    "js/settings.js",
    "js/utilities.js",
    "js/modals.js",
    "js/app.js",
];

module.exports = async function (context) {
    const projectDir = context.configuration.directories.project || process.cwd();
    const outDir = context.outDir || path.join(projectDir, "application");
    const zipPath = path.join(outDir, "update-pack.zip");

    console.log("[AfterBuild] Creating update-pack.zip for hot-updates...");

    const zip = new AdmZip();
    let fileCount = 0;

    for (const fileName of UPDATABLE_FILES) {
        const filePath = path.join(projectDir, fileName);
        if (fs.existsSync(filePath)) {
            const zipDir = path.dirname(fileName) !== '.' ? path.dirname(fileName) : '';
            zip.addLocalFile(filePath, zipDir || null);
            console.log(`[AfterBuild]   + ${fileName}`);
            fileCount++;
        } else {
            console.log(`[AfterBuild]   - ${fileName} (not found, skipping)`);
        }
    }

    if (fileCount === 0) {
        console.error("[AfterBuild] ERROR: No updatable files found!");
        return [];
    }

    zip.writeZip(zipPath);
    console.log(`[AfterBuild] Created update-pack.zip with ${fileCount} files`);

    // Return the path so electron-builder publishes it as a release asset
    return [zipPath];
};
