const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'config.js'));
const { getConnection } = require(path.join(__dirname, 'utils', 'connection.js')); // ИЗМЕНЕНИЕ

const IDL_PATH = path.join(__dirname, 'roulette_game.json');
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');

const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
let ALL_BOT_WALLETS = [];

function loadAllBotWallets() {
    if (ALL_BOT_WALLETS.length > 0) return;
    console.log("ЛОГ: [GameActions] Загрузка всех кошельков ботов в кэш...");
    const keypairs = [];
    const subdirs = fs.readdirSync(WALLETS_BASE_DIR);
    subdirs.forEach(subdirName => {
        const dirPath = path.join(WALLETS_BASE_DIR, subdirName);
        if (fs.statSync(dirPath).isDirectory()) {
            const files = fs.readdirSync(dirPath);
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const filePath = path.join(dirPath, file);
                    const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(filePath)));
                    keypairs.push(Keypair.fromSecretKey(keypairData));
                }
            });
        }
    });
    ALL_BOT_WALLETS = keypairs;
    console.log(`ЛОГ: [GameActions] Загружено ${ALL_BOT_WALLETS.length} кошельков.`);
}

function getRandomBotWallet() {
    loadAllBotWallets();
    if (ALL_BOT_WALLETS.length === 0) {
        throw new Error("Не найдено ни одного кошелька бота для выполнения действий.");
    }
    const randomIndex = Math.floor(Math.random() * ALL_BOT_WALLETS.length);
    return ALL_BOT_WALLETS[randomIndex];
}

function findInstructionDiscriminator(name) {
    const instruction = idl.instructions.find(ix => ix.name === name);
    if (!instruction) throw new Error(`Инструкция "${name}" не найдена в IDL`);
    return Buffer.from(instruction.discriminator);
}

async function sendTransactionWithHttp(transaction, signers) {
    const connection = getConnection(); // ИЗМЕНЕНИЕ
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = signers[0].publicKey;

    const signature = await connection.sendTransaction(transaction, signers, { skipPreflight: true });

    await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
    }, 'confirmed');
    
    return signature;
}

async function startNewRound() {
    const initiator = getRandomBotWallet();
    console.log(`[GameActions] Инициируем новый раунд от имени ${initiator.publicKey.toBase58()}...`);
    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], config.PROGRAM_ID);
    const startRoundIx = new TransactionInstruction({
        keys: [
            { pubkey: gameSessionPda, isWritable: true, isSigner: false },
            { pubkey: initiator.publicKey, isWritable: true, isSigner: true },
            { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false },
        ],
        programId: config.PROGRAM_ID,
        data: findInstructionDiscriminator('start_new_round'),
    });
    const transaction = new Transaction().add(startRoundIx);
    const signature = await sendTransactionWithHttp(transaction, [initiator]);
    console.log(`[GameActions] Новый раунд успешно начат. Транзакция: ${signature}`);
}

async function closeBets() {
    const closer = getRandomBotWallet();
    console.log(`[GameActions] Закрываем ставки от имени ${closer.publicKey.toBase58()}...`);
    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], config.PROGRAM_ID);
    const closeBetsIx = new TransactionInstruction({
        keys: [
            { pubkey: gameSessionPda, isWritable: true, isSigner: false },
            { pubkey: closer.publicKey, isWritable: true, isSigner: true },
            { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false },
        ],
        programId: config.PROGRAM_ID,
        data: findInstructionDiscriminator('close_bets'),
    });
    const transaction = new Transaction().add(closeBetsIx);
    const signature = await sendTransactionWithHttp(transaction, [closer]);
    console.log(`[GameActions] Ставки успешно закрыты. Транзакция: ${signature}`);
}

async function getRandom() {
    const randomInitiator = getRandomBotWallet();
    console.log(`[GameActions] Запрашиваем случайное число от имени ${randomInitiator.publicKey.toBase58()}...`);
    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], config.PROGRAM_ID);
    const getRandomIx = new TransactionInstruction({
        keys: [
            { pubkey: gameSessionPda, isWritable: true, isSigner: false },
            { pubkey: randomInitiator.publicKey, isWritable: true, isSigner: true },
        ],
        programId: config.PROGRAM_ID,
        data: findInstructionDiscriminator('get_random'),
    });
    const transaction = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }))
        .add(getRandomIx);
    const signature = await sendTransactionWithHttp(transaction, [randomInitiator]);
    console.log(`[GameActions] Случайное число успешно запрошено. Транзакция: ${signature}`);
}

module.exports = {
    startNewRound,
    closeBets,
    getRandom,
};