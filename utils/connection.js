const { Connection } = require('@solana/web3.js');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.js'));

const RPC_ENDPOINTS = [
    config.SYNDICA_RPC,
    config.QUICKNODE_RPC
];

let currentRpcIndex = 0;
let connection = new Connection(RPC_ENDPOINTS[currentRpcIndex], { commitment: 'confirmed' });

console.log(`[ConnectionManager] Initialized with RPC: ${RPC_ENDPOINTS[currentRpcIndex]}`);

function getConnection() {
    return connection;
}

async function rotateRpc() {
    currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
    const newRpcUrl = RPC_ENDPOINTS[currentRpcIndex];
    connection = new Connection(newRpcUrl, { commitment: 'confirmed' });
    console.warn(`[ConnectionManager] RPC limit reached or connection failed. Rotating to: ${newRpcUrl}`);
    // Небольшая пауза, чтобы новое соединение установилось
    await new Promise(resolve => setTimeout(resolve, 2000));
}

module.exports = {
    getConnection,
    rotateRpc,
};