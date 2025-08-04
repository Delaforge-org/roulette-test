const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const borsh = require('@coral-xyz/borsh');
const axios = require('axios');
const https = require('https');
const config = require(path.join(__dirname, 'config.js'));
const { getConnection } = require(path.join(__dirname, 'utils', 'connection.js'));

const IDL_PATH = path.join(__dirname, 'roulette_game.json');
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');
const API_BASE_URL = 'https://api.0xroulette.com/api';
const CONCURRENCY_LIMIT = 80;
const DELAY_BETWEEN_BATCHES_MS = 20;

const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
// --- ИЗМЕНЕНИЕ: PROGRAM_ID теперь всегда берется из IDL ---
const PROGRAM_ID = new PublicKey(idl.address);
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// --- НОВОЕ: Схема для VaultAccount ---
const VAULT_ACCOUNT_LAYOUT = borsh.struct([
    borsh.publicKey('token_mint'),
    borsh.publicKey('token_account'),
]);


console.log(`ЛОГ: Конфигурация для выдачи выигрышей загружена. ID Программы: ${PROGRAM_ID.toBase58()}`);


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

// --- ИЗМЕНЕНО: Более информативная реализация runInParallel с прогрессом ---
async function runInParallel(tasks, concurrencyLimit) {
    const results = [];
    const executing = [];
    let completed = 0;
    const total = tasks.length;
    let successes = 0;
    let failures = 0;

    for (const task of tasks) {
        const p = Promise.resolve().then(() => task()).then(result => {
            completed++;
            if (result?.status === 'success') successes++;
            if (result?.status === 'failed') failures++;
            // Обновляем строку прогресса
            process.stdout.write(`\rПрогресс выплат: ${completed}/${total} | Успешно: ${successes} | Ошибки: ${failures}`);
            return result;
        });
        results.push(p);

        if (concurrencyLimit <= tasks.length) {
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
    return results; 
}


async function claimWinForPlayer(botKeypair, roundToClaim, gameSessionPda) {
    const connection = getConnection();
    const playerPubkey = botKeypair.publicKey;
    try {
        const apiUrl = `${API_BASE_URL}/player-round-bets?player=${playerPubkey.toBase58()}&round=${roundToClaim.toString()}`;
        const response = await axios.get(apiUrl, { httpsAgent });
        if (!response.data || !response.data.bets || response.data.bets.length === 0) {
             return { status: 'no_win' }; // Явно указываем, что выигрыша нет
        }

        const totalPayoutAmount = response.data.bets.reduce((sum, bet) => sum + (Number(bet.payoutAmount) || 0), 0);
        const alreadyClaimed = response.data.alreadyClaimed === true;

        if (totalPayoutAmount > 0 && !alreadyClaimed) {
            const tokenMint = new PublicKey(response.data.bets[0].tokenMint);
            const [vaultPda] = await PublicKey.findProgramAddress([Buffer.from('vault'), tokenMint.toBuffer()], PROGRAM_ID);
            const [playerBetsPda] = await PublicKey.findProgramAddress([Buffer.from('player_bets'), gameSessionPda.toBuffer(), playerPubkey.toBuffer()], PROGRAM_ID);
            const playerAta = await getAssociatedTokenAddress(tokenMint, playerPubkey);

            const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
            if (!vaultAccountInfo) throw new Error(`Не удалось найти аккаунт хранилища (Vault) по адресу: ${vaultPda.toBase58()}`);
            
            const decodedVault = VAULT_ACCOUNT_LAYOUT.decode(vaultAccountInfo.data.slice(8));
            const vaultAta = decodedVault.token_account;

            const claimIx = new TransactionInstruction({
                keys: [
                    { pubkey: playerPubkey, isSigner: true, isWritable: true },
                    { pubkey: gameSessionPda, isSigner: false, isWritable: false },
                    { pubkey: playerBetsPda, isSigner: false, isWritable: true },
                    { pubkey: vaultPda, isSigner: false, isWritable: true },
                    { pubkey: vaultAta, isSigner: false, isWritable: true },
                    { pubkey: playerAta, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                ],
                programId: PROGRAM_ID,
                data: Buffer.concat([
                    findInstructionDiscriminator('claim_my_winnings'),
                    roundToClaim.toBuffer('le', 8),
                ]),
            });
            const transaction = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })).add(claimIx);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = playerPubkey;

            await connection.sendTransaction(transaction, [botKeypair], { skipPreflight: true });

            return { status: 'success' };
        }
        
        return { status: 'no_win' }; // Нет выигрыша или он уже забран
        
    } catch (error) {
        if (!error.response || error.response.status !== 404) {
            // Возвращаем логирование ошибок
            console.error(`\n   -> ОШИБКА для ${playerPubkey.toBase58()}: ${error.message}`);
        }
        return { status: 'failed' };
    }
}

async function claimWinnings() {
    const connection = getConnection();
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
            borsh.publicKey('authority'),
            borsh.u64('current_round'), borsh.i64('round_start_time'), borsh.u8('round_status'),
            borsh.option(borsh.u8(), 'winning_number'), borsh.i64('bets_closed_timestamp'),
            borsh.i64('get_random_timestamp'), borsh.u8('bump'), borsh.option(borsh.publicKey(), 'last_bettor'),
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
                        if (totalPayout > 0 && !response.data.alreadyClaimed) return wallet;
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
            console.log(`\n>>> Этап 2: Найдено ${winnersToClaim.length} победителей. Начинаем параллельную выплату...`);
            
            const claimTasks = winnersToClaim.map(botKeypair => 
                () => claimWinForPlayer(botKeypair, roundToClaim, gameSessionPda)
            );

            await runInParallel(claimTasks, CONCURRENCY_LIMIT);
            
            console.log(`\nВыплаты завершены.`);
        } else {
            console.log("\nИНФО: Победители среди ботов в этом раунде не найдены.");
        }
        console.log("\n>>> Скрипт завершил работу.");
    } catch (e) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА в скрипте claimWinnings:", e);
        throw e; // Пробрасываем ошибку наверх
    }
}

module.exports = { claimWinnings };