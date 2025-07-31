// Конфигурация API ключей и URL
const QUICKNODE_RPC = 'https://old-omniscient-panorama.solana-devnet.quiknode.pro/a0a7f9f467ae18075c4296273d56e5e84f0ad3ad/';
const SYNDICA_RPC = 'https://solana-devnet.api.syndica.io/api-key/4djv6PYW55oz2xsz6fbdJJgKe5oAwj6cf8nRDgPMuXr3npvTQ6oxRkg45Nw7wgEaE63AhewBW7MaSTeU8JPv3gK6TfkfXufPDoM';
const MONGO_URI = 'mongodb+srv://roulette-db-user:Ritzy7-Undercook1-Choosy1-Safeness6-Shininess6@roulette-db.vhgqhgc.mongodb.net/?retryWrites=true&w=majority&appName=roulette-db';
const { PublicKey } = require('@solana/web3.js');


const QUICKNODE_WSS = "wss://..."; // Заполните, если нужно

const SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/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";

module.exports = {
    QUICKNODE_RPC,
    QUICKNODE_WSS,
    SYNDICA_RPC,
    SLACK_WEBHOOK_URL,
    MONGO_URI,  
    PROGRAM_ID: new PublicKey("G4DQmdyZL7haBvZbjDKJ4w1wKZ1oQVR9CSu5yBW8EZJA"),
    BETTING_DURATION_MS: 5* 60 * 1000,        // 1 минута на ставки
    COOLDOWN_AFTER_CLOSE_MS: 15 * 1000,    // 15 секунд пауза после закрытия ставок
    COOLDOWN_AFTER_RANDOM_MS: 30 * 1000,   // 30 секунд пауза после получения выигрышного числа
};