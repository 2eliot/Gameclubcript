const fs = require('fs');
const path = require('path');

function stripWrappingQuotes(value) {
    if (!value) {
        return value;
    }

    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
        return value.slice(1, -1);
    }

    return value;
}

function loadEnvFile(filePath = path.join(__dirname, '.env')) {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }

    return true;
}

module.exports = {
    loadEnvFile
};