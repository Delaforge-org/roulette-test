const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'config.js'));

// --- Конфигурация ---
const RPC_URL = config.SYNDICA_RPC;
const IDL_PATH = path.join(__dirname, 'roulette_game.json');
const WALLETS_BASE_DIR = path.join(process.env.HOME, 'roulette-backend/test-wallets');
const CONCURRENCY_LIMIT = 40; // Увеличено для поддержки высокой скорости

// --- Загрузка и настройка ---
const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
const connection = new Connection(RPC_URL, { commitment: 'confirmed' });

let ALL_BOT_WALLETS = []; // Кэш для всех кошельков

// --- Вспомогательные функции ---

/**
 * Загружает все кошельки ботов в кэш, если он пуст.
 */
function loadAllBotWallets() {
    if (ALL_BOT_WALLETS.length > 0) {
        return; // Уже загружены
    }
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

/**
 * Выбирает случайный кошелек из загруженных.
 * @returns {Keypair}
 */
function getRandomBotWallet() {
    loadAllBotWallets(); // Убедиться, что кошельки загружены
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

// --- Экспортируемые функции действий ---

async function startNewRound() {
    const initiator = getRandomBotWallet();
    console.log(`[GameActions] Инициируем новый раунд от имени ${initiator.publicKey.toBase58()}...`);

    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], config.PROGRAM_ID);

    const startRoundIx = new TransactionInstruction({
        keys: [
            { pubkey: gameSessionPda, isWritable: true, isSigner: false },
            { pubkey: initiator.publicKey, isWritable: true, isSigner: true },
            { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false }, // SystemProgram
        ],
        programId: config.PROGRAM_ID,
        data: findInstructionDiscriminator('start_new_round'),
    });

    const transaction = new Transaction().add(startRoundIx);
    const signature = await sendAndConfirmTransaction(connection, transaction, [initiator]);
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
            { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false }, // SystemProgram
        ],
        programId: config.PROGRAM_ID,
        data: findInstructionDiscriminator('close_bets'),
    });

    const transaction = new Transaction().add(closeBetsIx);
    const signature = await sendAndConfirmTransaction(connection, transaction, [closer]);
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

    const signature = await sendAndConfirmTransaction(connection, transaction, [randomInitiator]);
    console.log(`[GameActions] Случайное число успешно запрошено. Транзакция: ${signature}`);
}

module.exports = {
    startNewRound,
    closeBets,
    getRandom,
};