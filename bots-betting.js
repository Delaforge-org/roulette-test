const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const config = require(path.join(__dirname, 'config.js'));

// --- Конфигурация ---
const RPC_URL = config.SYNDICA_RPC;
const IDL_PATH = path.join(__dirname, 'roulette_game.json');
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');
const CONCURRENCY_LIMIT = 40; // Увеличено для поддержки высокой скорости
const DELAY_BETWEEN_BATCHES_MS = 80; // Уменьшено для увеличения нагрузки до ~80 req/s

// ==============================================================================
//      КОНФИГУРАЦИЯ БОТОВ: ГРУППЫ, ТОКЕНЫ, ДЕЦИМАЛЫ
// ==============================================================================
const TOKEN_CONFIG = {
    GRN: {
        mint: new PublicKey("DhsFPhLMN1Bq8YQorjZZrYkZoZGHZxc6eemS3zzW5SCu"),
        decimals: 9,
        strategies: [
            () => getRandomAmount(400, 600),
            () => getRandomAmount(600, 800),
            () => getRandomAmount(800, 1000),
            () => getRandomAmount(1000, 1200),
            () => getRandomAmount(700, 900),
            () => getRandomAmount(400, 600),
            () => getRandomAmount(600, 800),
            () => getRandomAmount(800, 1000),
            () => getRandomAmount(1000, 1200),
            () => getRandomAmount(700, 900),
        ]
    },
    MAR: {
        mint: new PublicKey("E3GVbwcczoM6HJnWHR1NJ2bJbpB5kDDTYqNpusEUec8M"),
        decimals: 6,
        strategies: [
            () => getRandomAmount(600, 900),
            () => getRandomAmount(900, 1200),
            () => getRandomAmount(1200, 1500),
            () => getRandomAmount(1500, 1800),
            () => getRandomAmount(1000, 1400),
            () => getRandomAmount(600, 900),
            () => getRandomAmount(900, 1200),
            () => getRandomAmount(1200, 1500),
            () => getRandomAmount(1500, 1800),
            () => getRandomAmount(1000, 1400),
        ]
    },
    SAO: {
        mint: new PublicKey("GyGq8CNEJuY6Dmefjut2jBCEuVAaFyBHCiqdUboHKXcS"),
        decimals: 6,
        strategies: [
            () => getRandomAmount(300, 450),
            () => getRandomAmount(450, 600),
            () => getRandomAmount(600, 750),
            () => getRandomAmount(750, 900),
            () => getRandomAmount(500, 700),
            () => getRandomAmount(300, 450),
            () => getRandomAmount(450, 600),
            () => getRandomAmount(600, 750),
            () => getRandomAmount(750, 900),
            () => getRandomAmount(500, 700),
        ]
    },
    LOI: {
        mint: new PublicKey("Fvmu22STa3mYx2bHQHMeiSGYYCjtuAsMLFsVpNWuRwcJ"),
        decimals: 6,
        strategies: [
            () => getRandomAmount(50, 75),
            () => getRandomAmount(75, 100),
            () => getRandomAmount(100, 125),
            () => getRandomAmount(125, 150),
            () => getRandomAmount(80, 120),
            () => getRandomAmount(50, 75),
            () => getRandomAmount(75, 100),
            () => getRandomAmount(100, 125),
            () => getRandomAmount(125, 150),
            () => getRandomAmount(80, 120),
        ]
    },
    USDC: {
        mint: new PublicKey("4FiYqUg9gw5wyQ2po9RGp3EXZns48ZUD4quMwq53sdwT"),
        decimals: 6,
        strategies: [
            () => getRandomAmount(2, 3),
            () => getRandomAmount(3, 4),
            () => getRandomAmount(4, 5),
            () => getRandomAmount(5, 6),
            () => getRandomAmount(3, 5),
            () => getRandomAmount(2, 3),
            () => getRandomAmount(3, 4),
            () => getRandomAmount(4, 5),
            () => getRandomAmount(5, 6),
            () => getRandomAmount(3, 5),
        ]
    },
    OLS: {
        mint: new PublicKey("5ei1ggNH5vjdMVvXbAENiehBmwhHhB2v45ddTigVgdUM"),
        decimals: 6,
        strategies: [
            () => getRandomAmount(36000, 54000),
            () => getRandomAmount(54000, 72000),
            () => getRandomAmount(72000, 90000),
            () => getRandomAmount(90000, 108000),
            () => getRandomAmount(60000, 80000),
            () => getRandomAmount(36000, 54000),
            () => getRandomAmount(54000, 72000),
            () => getRandomAmount(72000, 90000),
            () => getRandomAmount(90000, 108000),
            () => getRandomAmount(60000, 80000),
        ]
    },
};
const WALLET_SUBDIRS = Object.keys(TOKEN_CONFIG);
// ==============================================================================


// --- Загрузка IDL и настройка соединения ---
const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const connection = new Connection(RPC_URL, { commitment: 'processed' });

console.log("ЛОГ: Конфигурация загружена");
console.log(`ЛОГ: ID Программы: ${PROGRAM_ID.toBase58()}`);
console.log(`ЛОГ: RPC URL: ${RPC_URL}`);

// --- Типы ставок (для рандомизации) ---
const BET_TYPES = {
    'Straight': 0, 'Split': 1, 'Corner': 2, 'Street': 3, 'SixLine': 4,
    'FirstFour': 5, 'Red': 6, 'Black': 7, 'Even': 8, 'Odd': 9, 'Manque': 10,
    'Passe': 11, 'Column': 12, 'P12': 13, 'M12': 14, 'D12': 15,
};
const BET_TYPE_VALUES = Object.values(BET_TYPES);

/**
 * Вспомогательная функция для перевода токенов в их наименьшие единицы.
 * @param {number} amount - Сумма в обычных токенах (целое число).
 * @param {number} decimals - Количество знаков после запятой у токена.
 * @returns {BN} Сумма в наименьших единицах (лампортах) в формате BN.js.
 */
function toBaseUnits(amount, decimals) {
    const factor = new BN(10).pow(new BN(decimals));
    return new BN(amount).mul(factor);
}

// --- Вспомогательные функции ---

function getRandomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomBetType() {
    return BET_TYPE_VALUES[Math.floor(Math.random() * BET_TYPE_VALUES.length)];
}

function getRandomNumbersForBet(betType) {
    const numbers = [0, 0, 0, 0];
    let n1;

    switch (betType) {
        case 0: // Straight
            numbers[0] = getRandomAmount(0, 36);
            break;
        case 1: // Split
            if (Math.random() < 0.5) { // Vertical
                n1 = getRandomAmount(1, 33);
                numbers[0] = n1; numbers[1] = n1 + 3;
            } else { // Horizontal
                n1 = 1 + 3 * getRandomAmount(0, 11) + getRandomAmount(0, 1);
                numbers[0] = n1; numbers[1] = n1 + 1;
            }
            break;
        case 2: // Corner
            numbers[0] = 1 + 3 * getRandomAmount(0, 10) + getRandomAmount(0, 1);
            break;
        case 3: // Street
            numbers[0] = 1 + 3 * getRandomAmount(0, 11);
            break;
        case 4: // SixLine
            numbers[0] = 1 + 3 * getRandomAmount(0, 10);
            break;
        case 12: // Column
            numbers[0] = getRandomAmount(1, 3);
            break;
        default:
            break;
    }
    return numbers;
}

function loadWalletsByGroup() {
    console.log("ЛОГ: Загрузка кошельков по группам...");
    const wallets = {};
    WALLET_SUBDIRS.forEach(subdir => {
        wallets[subdir] = [];
        const dirPath = path.join(WALLETS_BASE_DIR, subdir);
        if (!fs.existsSync(dirPath)) {
            console.error(`КРИТИЧЕСКАЯ ОШИБКА: Директория с кошельками не найдена: ${dirPath}`);
            console.error("Пожалуйста, запустите скрипт 'generate-wallets.sh' перед запуском ботов.");
            process.exit(1);
        }
        const files = fs.readdirSync(dirPath);
        files.forEach(file => {
            if (file.endsWith('.json')) {
                const filePath = path.join(dirPath, file);
                const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(filePath)));
                wallets[subdir].push(Keypair.fromSecretKey(keypairData));
            }
        });
        console.log(`ЛОГ: Загружено ${wallets[subdir].length} кошельков из группы ${subdir}`);
    });
    return wallets;
}

function findInstructionDiscriminator(name) {
    const instruction = idl.instructions.find(ix => ix.name === name);
    if (!instruction) throw new Error(`Инструкция "${name}" не найдена в IDL`);
    return Buffer.from(instruction.discriminator);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

async function runInParallel(tasks, concurrencyLimit) {
    const results = [];
    const executing = [];
    let completed = 0;
    const total = tasks.length;

    console.log(`\n>>> Запуск ${total} ставок с параллелизмом ${concurrencyLimit} и задержкой ${DELAY_BETWEEN_BATCHES_MS} мс...\n`);

    for (const task of tasks) {
        const p = Promise.resolve().then(() => task()).finally(() => {
            completed++;
            process.stdout.write(`\rПрогресс: ${completed}/${total} ставок обработано...`);
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
    process.stdout.write('\n'); // Новая строка после завершения прогресса
}


// --- Основная логика ---
async function runBettingBots() { // Переименовываем main в runBettingBots
    console.log(">>> [Bots] Запуск скрипта для размещения ставок ботами...");

    const walletsByGroup = loadWalletsByGroup();
    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], PROGRAM_ID);

    console.log(`ЛОГ: GameSession PDA: ${gameSessionPda.toBase58()}`);

    // 1. Создание очереди всех ставок
    const bettingQueue = [];
    for (const groupName in walletsByGroup) {
        const wallets = walletsByGroup[groupName];
        const config = TOKEN_CONFIG[groupName];

        for (const wallet of wallets) {
            for (const strategy of config.strategies) {
                const amountInTokens = strategy(); // Получаем сумму в обычных токенах (e.g., 800)
                const amountInBaseUnits = toBaseUnits(amountInTokens, config.decimals); // Конвертируем в лампорты

                bettingQueue.push({
                    playerKeypair: wallet,
                    amountBN: amountInBaseUnits,
                    amountForLog: amountInTokens,
                    betType: getRandomBetType(),
                    group: groupName,
                    tokenMint: config.mint,
                });
            }
        }
    }

    // 2. Перемешивание очереди для реалистичности
    shuffleArray(bettingQueue);
    console.log(`ЛОГ: Создана и перемешана очередь из ${bettingQueue.length} ставок.`);

    // 3. Создание и выполнение задач
    const betTasks = bettingQueue.map((betInfo) => {
        return async () => {
            const { playerKeypair, amountBN, amountForLog, betType, group, tokenMint } = betInfo;
            const playerPubkey = playerKeypair.publicKey;

            try {
                const [playerBetsPda] = await PublicKey.findProgramAddress([Buffer.from('player_bets'), gameSessionPda.toBuffer(), playerPubkey.toBuffer()], PROGRAM_ID);
                const [vaultPda] = await PublicKey.findProgramAddress([Buffer.from('vault'), tokenMint.toBuffer()], PROGRAM_ID);
                const playerAta = await getAssociatedTokenAddress(tokenMint, playerPubkey);

                // --- ИСПРАВЛЕНИЕ: Загрузка аккаунта хранилища для получения корректного ATA ---
                // Мы не выводим ATA хранилища, а читаем его напрямую из аккаунта Vault.
                // Это гарантирует, что мы используем тот же токен-счет, который был создан при инициализации хранилища.
                const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
                if (!vaultAccountInfo) {
                    throw new Error(`Не удалось найти аккаунт хранилища (Vault) по адресу: ${vaultPda.toBase58()}`);
                }
                // Согласно IDL, поле `token_account` идет вторым после `token_mint`.
                // Смещение: 8 (дискриминатор) + 32 (token_mint) = 40. Длина: 32.
                const vaultAta = new PublicKey(vaultAccountInfo.data.slice(40, 72));
                // --- КОНЕЦ ИСПРАВЛЕНИЯ ---

                const betData = {
                    amount: amountBN,
                    betType: betType,
                    numbers: getRandomNumbersForBet(betType),
                };

                const betBuffer = Buffer.alloc(13);
                betData.amount.toBuffer('le', 8).copy(betBuffer, 0);
                betBuffer.writeUInt8(betData.betType, 8);
                Buffer.from(betData.numbers).copy(betBuffer, 9);
                
                const placeBetIx = new TransactionInstruction({
                    keys: [
                        { pubkey: vaultPda, isWritable: true, isSigner: false },
                        { pubkey: gameSessionPda, isWritable: true, isSigner: false },
                        { pubkey: playerAta, isWritable: true, isSigner: false },
                        { pubkey: vaultAta, isWritable: true, isSigner: false },
                        { pubkey: playerPubkey, isWritable: true, isSigner: true },
                        { pubkey: playerBetsPda, isWritable: true, isSigner: false },
                        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
                    ],
                    programId: PROGRAM_ID,
                    data: Buffer.concat([
                        findInstructionDiscriminator('place_bet'),
                        betBuffer,
                    ]),
                });

                const transaction = new Transaction()
                  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
                  .add(placeBetIx);

                // --- ИЗМЕНЕННАЯ ЛОГИКА ОТПРАВКИ И ПОДТВЕРЖДЕНИЯ ---

                // 1. Получаем свежий blockhash. Это заставит confirmTransaction использовать HTTP polling вместо WS.
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
                transaction.recentBlockhash = blockhash;
                transaction.feePayer = playerPubkey;

                // 2. Отправляем транзакцию, не дожидаясь подтверждения через WebSocket.
                const signature = await connection.sendTransaction(transaction, [playerKeypair], {
                    skipPreflight: true,
                });

                // 3. Подтверждаем транзакцию, используя HTTP-polling.
                const confirmation = await connection.confirmTransaction({
                    signature,
                    blockhash,
                    lastValidBlockHeight
                }, 'processed');
                
                if (confirmation.value.err) {
                    throw new Error(`Transaction failed confirmation: ${JSON.stringify(confirmation.value.err)}`);
                }

                // Успешный лог скрыт, чтобы не засорять консоль. Можно раскомментировать для отладки.
                // console.log(`УСПЕХ: Ставка от ${playerPubkey.toBase58().substring(0, 5)} [${group}] на ${amountForLog} | TX: ${signature.substring(0, 15)}...`);

            } catch (error) {
                console.error(`\n!!! КРИТИЧЕСКАЯ ОШИБКА при ставке от ${playerPubkey.toBase58()} [${group}] !!!`);
                console.error(`Сумма: ${amountForLog}, Тип ставки: ${betType}`);
                if (error.logs) {
                    console.error("ЛОГИ ПРОГРАММЫ:", error.logs);
                } else {
                    console.error("ДЕТАЛИ ОШИБКИ:", error);
                }
            }
        };
    });

    await runInParallel(betTasks, CONCURRENCY_LIMIT);
    console.log("\n>>> [Bots] Все ставки успешно размещены!");
}

// Удаляем старый вызов main()
// main().catch(err => { ... });

// Экспортируем функцию
module.exports = {
    runBettingBots,
};

