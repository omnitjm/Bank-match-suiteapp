/**
 * suitecloud.config.js
 *
 * SuiteCloud CLI configuration for Bank Match SuiteApp.
 *
 * One-time setup:
 *   npm install
 *   npx suitecloud account:setup --authid bank-match-auth
 *
 * Deploy:
 *   npm run deploy            (validate + deploy)
 *   npm run deploy:no-prompt  (skip confirmation prompt — safe for CI)
 *   npm run validate          (dry-run, no changes made)
 */
module.exports = {
    commands: {
        'project:deploy': {
            authid: 'bank-match-auth'
        },
        'project:validate': {
            authid: 'bank-match-auth'
        }
    }
};
