const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const borsh = require('@coral-xyz/borsh');
const axios = require('axios');
const https = require('https');
const config = require(path.join(__dirname, 'config.js'));

// --- Конфигурация ---
const RPC_URL = config.SYNDICA_RPC;
const IDL_PATH = path.join(__dirname, 'roulette_game.json');
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');
const API_BASE_URL = 'https://api.0xroulette.com/api';
const CONCURRENCY_LIMIT = 20;
const DELAY_BETWEEN_BATCHES_MS = 80;

// --- Загрузка и настройка ---
const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const connection = new Connection(RPC_URL, { commitment: 'confirmed' });
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

console.log("ЛОГ: Конфигурация для выдачи выигрышей загружена.");
console.log(`ЛОГ: RPC URL: ${RPC_URL}`);

// --- Вспомогательные функции ---

function loadAllBotWallets() {
    console.log("ЛОГ: Загрузка всех кошельков ботов...");
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
    console.log(`ЛОГ: Успешно загружено ${keypairs.length} кошельков.`);
    return keypairs;
}

function findInstructionDiscriminator(name) {
    const instruction = idl.instructions.find(ix => ix.name === name);
    if (!instruction) throw new Error(`Инструкция "${name}" не найдена в IDL`);
    return Buffer.from(instruction.discriminator);
}

async function runInParallel(tasks, concurrencyLimit) {
    const allResults = [];
    const executing = [];
    let completed = 0;
    const total = tasks.length;
    process.stdout.write(`\rПрогресс проверки: ${completed}/${total}`);

    for (const task of tasks) {
        const p = Promise.resolve().then(() => task()).then(result => {
            completed++;
            process.stdout.write(`\rПрогресс проверки: ${completed}/${total}`);
            return result;
        });
        allResults.push(p);

        if (concurrencyLimit <= total) {
            const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= concurrencyLimit) {
                await Promise.race(executing);
            }
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
    process.stdout.write('\n');
    return Promise.all(allResults);
}


async function claimWinForPlayer(botKeypair, roundToClaim, gameSessionPda) {
    const playerPubkey = botKeypair.publicKey;
    // console.log(`   -> Подготовка транзакции для ${playerPubkey.toBase58()}`); // Скрыто для уменьшения спама

    try {
        const apiUrl = `${API_BASE_URL}/player-round-bets?player=${playerPubkey.toBase58()}&round=${roundToClaim.toString()}`;
        const response = await axios.get(apiUrl, { httpsAgent });

        if (!response.data || !response.data.bets || response.data.bets.length === 0) return;
        
        const totalPayoutAmount = response.data.bets.reduce((sum, bet) => sum + (Number(bet.payoutAmount) || 0), 0);
        const alreadyClaimed = response.data.alreadyClaimed === true;

        if (totalPayoutAmount > 0 && !alreadyClaimed) {
            console.log(`  -> ПОБЕДИТЕЛЬ: ${playerPubkey.toBase58()}. Сумма: ${totalPayoutAmount}. Отправка транзакции...`);
            
            const tokenMint = new PublicKey(response.data.bets[0].tokenMint);
            const [vaultPda] = await PublicKey.findProgramAddress([Buffer.from('vault'), tokenMint.toBuffer()], PROGRAM_ID);
            const [playerBetsPda] = await PublicKey.findProgramAddress([Buffer.from('player_bets'), gameSessionPda.toBuffer(), playerPubkey.toBuffer()], PROGRAM_ID);
            const playerAta = await getAssociatedTokenAddress(tokenMint, playerPubkey);

            const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
            if (!vaultAccountInfo) {
                throw new Error(`Не удалось найти аккаунт хранилища (Vault) по адресу: ${vaultPda.toBase58()}`);
            }
            const vaultAta = new PublicKey(vaultAccountInfo.data.slice(40, 72));

            const [claimRecordPda] = await PublicKey.findProgramAddress([Buffer.from('claim_record'), playerPubkey.toBuffer(), roundToClaim.toBuffer('le', 8)], PROGRAM_ID);
            
            const claimRecordInfo = await connection.getAccountInfo(claimRecordPda);
            if(claimRecordInfo) {
               console.warn(`   -> ПРЕДУПРЕЖДЕНИЕ: Запись о выигрыше для ${playerPubkey.toBase58()} уже существует в блокчейне. Пропускаем.`);
               return;
            }

            const claimIx = new TransactionInstruction({
                keys: [
                    { pubkey: playerPubkey, isSigner: true, isWritable: true },
                    { pubkey: gameSessionPda, isSigner: false, isWritable: false },
                    { pubkey: playerBetsPda, isSigner: false, isWritable: false },
                    { pubkey: vaultPda, isSigner: false, isWritable: true },
                    { pubkey: vaultAta, isSigner: false, isWritable: true },
                    { pubkey: playerAta, isSigner: false, isWritable: true },
                    { pubkey: claimRecordPda, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, 
                ],
                programId: PROGRAM_ID,
                data: Buffer.concat([
                    findInstructionDiscriminator('claim_my_winnings'),
                    roundToClaim.toBuffer('le', 8),
                ]),
            });

            const transaction = new Transaction()
                .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
                .add(claimIx);
            
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = playerPubkey;

            const signature = await connection.sendTransaction(transaction, [botKeypair]);

            await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

            console.log(`   -> УСПЕХ: Выигрыш для ${playerPubkey.toBase58()} получен! Транзакция: ${signature}`);
            return { status: 'success' };
        }
    } catch (error) {
        if (error.response && error.response.status !== 404) {
            // Игнорируем, у бота не было ставок
        } else {
            console.error(`\n   -> ОШИБКА для ${playerPubkey.toBase58()}: ${error.message}`);
        }
        return { status: 'failed' };
    }
}

// --- ИЗМЕНЕНИЕ 1: Переименовываем 'main' в 'claimWinnings', чтобы соответствовать оркестратору ---
async function claimWinnings() {
    console.log("\n>>> [Bots] Запуск скрипта для выплаты выигрышей...");

    try {
        console.log("ЛОГ: Получение состояния игровой сессии...");
        const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], PROGRAM_ID);
        const gameSessionAccountInfo = await connection.getAccountInfo(gameSessionPda);
        if (!gameSessionAccountInfo) {
            console.error("КРИТИЧЕСКАЯ ОШИБКА: Аккаунт GameSession не найден.");
            return;
        }

        const gameSessionLayout = borsh.struct([
            borsh.u64('current_round'),
            borsh.i64('round_start_time'),
            borsh.u8('round_status'),
            borsh.option(borsh.u8(), 'winning_number'),
            borsh.i64('bets_closed_timestamp'),
            borsh.i64('get_random_timestamp'),
            borsh.u8('bump'),
            borsh.option(borsh.publicKey(), 'last_bettor'),
            borsh.u64('last_completed_round'),
        ]);
        const gameSession = gameSessionLayout.decode(gameSessionAccountInfo.data.slice(8));

        if (gameSession.winning_number === null || gameSession.last_completed_round.isZero()) {
            console.log("ИНФО: В последнем раунде еще не определено выигрышное число. Выход.");
            return;
        }

        const roundToClaim = gameSession.last_completed_round;
        console.log(`ЛОГ: Раунд для проверки выигрышей: ${roundToClaim.toString()}. Выигрышное число: ${gameSession.winning_number}`);

        const botWallets = loadAllBotWallets();
        
        console.log("\n>>> Этап 1: Параллельная проверка выигрышей через API...");
        const checkTasks = botWallets.map(wallet => () => {
            return axios.get(`${API_BASE_URL}/player-round-bets?player=${wallet.publicKey.toBase58()}&round=${roundToClaim.toString()}`, { httpsAgent })
                .then(response => {
                    if (response.data && response.data.bets && response.data.bets.length > 0) {
                        const totalPayout = response.data.bets.reduce((sum, bet) => sum + (Number(bet.payoutAmount) || 0), 0);
                        if (totalPayout > 0 && !response.data.alreadyClaimed) {
                            return wallet; // Возвращаем keypair, если есть что забирать
                        }
                    }
                    return null;
                })
                .catch(error => {
                    if (!error.response || error.response.status !== 404) {
                        console.error(`\nAPI ошибка для ${wallet.publicKey.toBase58()}: ${error.message}`);
                    }
                    return null;
                });
        });

        const results = await runInParallel(checkTasks, CONCURRENCY_LIMIT);
        const winnersToClaim = results.filter(Boolean);

        if (winnersToClaim.length > 0) {
            console.log(`\n>>> Этап 2: Найдено ${winnersToClaim.length} победителей. Начинаем последовательную выплату...`);
            let successCount = 0;
            for (const [index, botKeypair] of winnersToClaim.entries()) {
                console.log(`\n--- Выплата ${index + 1}/${winnersToClaim.length} ---`);
                try {
                    const result = await claimWinForPlayer(botKeypair, roundToClaim, gameSessionPda);
                    if(result?.status === 'success') successCount++;
                } catch (err) {
                    console.error(`\n!!! КРИТИЧЕСКАЯ ОШИБКА во время выплаты. !!!`);
                    console.error(err);
                }
            }
            console.log(`\nВыплаты завершены. Успешно: ${successCount} из ${winnersToClaim.length}.`);
        } else {
            console.log("\nИНФО: Победители среди ботов в этом раунде не найдены.");
        }

        console.log("\n>>> Скрипт завершил работу.");
    } catch (e) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА в скрипте claimWinnings:", e);
    }
}

// --- ИЗМЕНЕНИЕ 2: Удаляем старый самозапуск скрипта ---
// main().catch(err => { ... });

// --- ИЗМЕНЕНИЕ 3: Убеждаемся, что экспортируется правильная функция ---
module.exports = { claimWinnings };