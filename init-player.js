const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const { SYNDICA_RPC } = require('./config.js');

// --- Загрузка IDL ---
const IDL_PATH = './roulette_game.json';
let idl;
try {
    console.log("ЛОГ: Попытка загрузить IDL...");
    idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
    console.log('ЛОГ: IDL успешно загружен.');
} catch (err) {
    console.error(`КРИТИЧЕСКАЯ ОШИБКА: Не удалось загрузить IDL из ${IDL_PATH}:`, err);
    process.exit(1);
}

// --- Конфигурация ---
const RPC_URL = SYNDICA_RPC;
const PROGRAM_ID = new PublicKey(idl.address);
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');
const WALLET_SUBDIRS = ['GRN', 'MAR', 'SAO', 'LOI', 'USDC', 'OLS'];
const CONCURRENCY_LIMIT = 15;
const DELAY_BETWEEN_BATCHES_MS = 200;
console.log("ЛОГ: Конфигурация установлена");
console.log(`ЛОГ: ID Программы: ${PROGRAM_ID.toBase58()}`);
console.log(`ЛОГ: RPC URL: ${RPC_URL}`);

const connection = new Connection(RPC_URL, 'confirmed');
console.log("ЛОГ: Соединение с RPC создано");

/**
 * Находит дискриминатор для инструкции в IDL.
 */
function findInstructionDiscriminator(idl, instructionName) {
    const instruction = idl.instructions.find(ix => ix.name === instructionName);
    if (!instruction || !instruction.discriminator) {
        throw new Error(`Дискриминатор для инструкции "${instructionName}" не найден в IDL`);
    }
    return Buffer.from(instruction.discriminator);
}

/**
 * Загружает все ключевые пары кошельков из указанных поддиректорий.
 */
function loadWallets() {
    console.log("ЛОГ: Загрузка ключевых пар кошельков...");
    const keypairs = [];
    WALLET_SUBDIRS.forEach(subdir => {
        const dirPath = path.join(WALLETS_BASE_DIR, subdir);
        try {
            const files = fs.readdirSync(dirPath);
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const filePath = path.join(dirPath, file);
                    try {
                        const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(filePath)));
                        const keypair = Keypair.fromSecretKey(keypairData);
                        keypairs.push(keypair);
                    } catch (e) {
                        console.warn(`ПРЕДУПРЕЖДЕНИЕ: Не удалось загрузить ключ из ${filePath}. Пропускаем. Ошибка: ${e.message}`);
                    }
                }
            });
        } catch (e) {
             console.error(`ОШИБКА: Не удалось прочитать директорию ${dirPath}. Пропускаем. Ошибка: ${e.message}`);
        }
    });
    console.log(`ЛОГ: Успешно загружено ${keypairs.length} кошельков.`);
    return keypairs;
}

/**
 * Инициализирует аккаунт PlayerBets для одного игрока, если он еще не существует.
 */
async function initializePlayer(playerKeypair, gameSessionPda) {
    const playerPubkey = playerKeypair.publicKey;
    console.log(`\n--- Обработка игрока: ${playerPubkey.toBase58()} ---`);

    // Находим PDA для аккаунта ставок игрока
    console.log(`ЛОГ: Поиск PlayerBets PDA для ${playerPubkey.toBase58()}`);
    const [playerBetsPda] = await PublicKey.findProgramAddress(
        [Buffer.from('player_bets'), gameSessionPda.toBuffer(), playerPubkey.toBuffer()],
        PROGRAM_ID
    );
    console.log(`ЛОГ: PlayerBets PDA найден: ${playerBetsPda.toBase58()}`);

    try {
        // 1. Проверяем, существует ли аккаунт
        const playerBetsAccount = await connection.getAccountInfo(playerBetsPda);

        if (playerBetsAccount !== null) {
            console.log(`ИНФО: Аккаунт PlayerBets ${playerBetsPda.toBase58()} для игрока ${playerPubkey.toBase58()} уже существует. Пропускаем.`);
            return { status: 'skipped', player: playerPubkey.toBase58() };
        }

        console.log(`ИНФО: Аккаунт PlayerBets не существует. Начинаем инициализацию...`);

        // 2. Готовим транзакцию
        const discriminator = findInstructionDiscriminator(idl, 'initialize_player_bets');
        console.log("ЛОГ: Найден дискриминатор для 'initialize_player_bets'.");

        const keys = [
            { pubkey: playerPubkey, isSigner: true, isWritable: true },
            { pubkey: gameSessionPda, isSigner: false, isWritable: false },
            { pubkey: playerBetsPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ];

        const instruction = new TransactionInstruction({
            keys: keys,
            programId: PROGRAM_ID,
            data: discriminator,
        });

        const transaction = new Transaction().add(instruction);
        console.log("ЛОГ: Транзакция создана. Отправка...");

        // 3. Отправляем транзакцию без ожидания подтверждения
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = playerPubkey;

        const transactionSignature = await connection.sendTransaction(
            transaction,
            [playerKeypair],
            { skipPreflight: true }
        );

        console.log(`УСПЕХ: Транзакция инициализации для ${playerPubkey.toBase58()} отправлена.`);
        console.log(`   TX ID: ${transactionSignature}`);

        return { status: 'success', player: playerPubkey.toBase58(), signature: transactionSignature };

    } catch (error) {
        console.error(`ОШИБКА: Не удалось инициализировать PlayerBets для ${playerPubkey.toBase58()}:`);
        // Проверяем, есть ли детальная информация об ошибке, и выводим ее
        const errorDetails = error.toString();
        console.error(errorDetails);
        if (error.logs) {
            console.error('   Логи блокчейна:', error.logs);
        }
        return { status: 'failed', player: playerPubkey.toBase58() };
    }
}

/**
 * Выполняет задачи параллельно с ограничением.
 */
async function runInParallel(tasks, concurrencyLimit) {
    const results = [];
    const executing = [];
    let completed = 0;
    const total = tasks.length;
    let successes = 0;
    let skips = 0;
    let failures = 0;

    console.log(`\n>>> Запуск ${total} задач с параллелизмом ${concurrencyLimit}...\n`);

    for (const task of tasks) {
        const p = Promise.resolve().then(() => task()).then(result => {
            completed++;
            if(result.status === 'success') successes++;
            if(result.status === 'skipped') skips++;
            if(result.status === 'failed') failures++;
            process.stdout.write(`\rПрогресс: ${completed}/${total} | Успешно: ${successes} | Пропущено: ${skips} | Ошибки: ${failures}`);
            return result;
        });
        results.push(p);

        if (concurrencyLimit <= total) {
            const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= concurrencyLimit) {
                await Promise.race(executing);
            }
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }

    await Promise.all(results);
    process.stdout.write('\n'); // Новая строка после завершения
}

/**
 * Основная функция выполнения скрипта
 */
async function main() {
    console.log(">>> Запуск скрипта инициализации игроков...");

    // 1. Находим PDA игровой сессии
    console.log("ЛОГ: Поиск GameSession PDA...");
    const [gameSessionPda] = await PublicKey.findProgramAddress(
        [Buffer.from('game_session')],
        PROGRAM_ID
    );
    console.log(`ЛОГ: GameSession PDA найден по адресу: ${gameSessionPda.toBase58()}`);

    // Проверяем, что аккаунт сессии существует, иначе инициализация невозможна
    const gameSessionAccount = await connection.getAccountInfo(gameSessionPda);
    if (!gameSessionAccount) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА: Аккаунт GameSession не найден. Пожалуйста, сначала запустите init-game.js.");
        process.exit(1);
    }
    console.log("ИНФО: Аккаунт GameSession найден. Продолжаем инициализацию игроков.");

    // 2. Загружаем все кошельки
    const wallets = loadWallets();
    if (wallets.length === 0) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА: Кошельки не найдены. Проверьте путь WALLETS_BASE_DIR и наличие файлов .json в подпапках.");
        process.exit(1);
    }

    // 3. Инициализируем каждого игрока последовательно
    // Используем последовательный цикл, чтобы избежать перегрузки RPC и для более чистого вывода логов.
    const tasks = wallets.map(wallet => () => initializePlayer(wallet, gameSessionPda));
    await runInParallel(tasks, CONCURRENCY_LIMIT);

    console.log("\n>>> Выполнение скрипта завершено.");
}

main().catch(err => {
    console.error(">>> Необработанная ошибка в основном потоке выполнения:", err);
});
