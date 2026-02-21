require('dotenv').config();
const { initializeSheet } = require('./data/googleSheets');
const bot = require('./bot');

initializeSheet().then(() => {
  console.log('Department subscription bot is running. Press Ctrl+C to stop.');
});
