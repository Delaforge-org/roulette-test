const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const borsh = require('@coral-xyz/borsh');
const axios = require('axios');
const https = require('https');
const config = require(path.join(__dirname, 'config.js'));
const { getConnection } = require(path.join(__dirname, 'utils', 'connection.js'));
const BN = require('bn.js');

// --- КОНФИГУРАЦИЯ ---
const ROUND_TO_CLAIM = 4;
// --------------------

const IDL_PATH = path.join(__dirname, 'roulette_game.json');
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');
const API_BASE_URL = 'https://api.0xroulette.com/api';
const CONCURRENCY_LIMIT = 20;
const DELAY_BETWEEN_BATCHES_MS = 80;

const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
const PROGRAM_ID = config.PROGRAM_ID;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

console.log(`--- СКРИПТ АВАРИЙНОГО СБОРА ВЫИГРЫШЕЙ ДЛЯ РАУНДА #${ROUND_TO_CLAIM} ---`);
console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);


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
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        allResults.push(p);
        if (concurrencyLimit <= tasks.length) {
            const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= concurrencyLimit) {
                await Promise.race(executing);
            }
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
    return Promise.all(allResults);
}

async function claimWinForPlayer(botKeypair, roundToClaim, gameSessionPda) {
    const connection = getConnection();
    const playerPubkey = botKeypair.publicKey;
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
            if (!vaultAccountInfo) throw new Error(`Не удалось найти аккаунт хранилища (Vault) по адресу: ${vaultPda.toBase58()}`);
            const vaultAta = new PublicKey(vaultAccountInfo.data.slice(40, 72));
            const [claimRecordPda] = await PublicKey.findProgramAddress([Buffer.from('claim_record'), playerPubkey.toBuffer(), roundToClaim.toBuffer('le', 8)], PROGRAM_ID);
            const claimRecordInfo = await connection.getAccountInfo(claimRecordPda);
            if (claimRecordInfo) {
                console.warn(`   -> ПРЕДУПРЕЖДЕНИЕ: Запись о выигрыше для ${playerPubkey.toBase58()} уже существует. Пропускаем.`);
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
            const transaction = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })).add(claimIx);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = playerPubkey;
            await connection.sendTransaction(transaction, [botKeypair], { skipPreflight: true });
            console.log(`   -> УСПЕХ: Транзакция на получение выигрыша для ${playerPubkey.toBase58()} отправлена.`);
            return { status: 'success' };
        }
    } catch (error) {
        if (!error.response || error.response.status !== 404) {
            console.error(`\n   -> ОШИБКА для ${playerPubkey.toBase58()}: ${error.message}`);
        }
        return { status: 'failed' };
    }
}

async function main() {
    const connection = getConnection();
    try {
        console.log("ЛОГ: Получение состояния игровой сессии (нужен для PDA)...");
        const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], PROGRAM_ID);
        const gameSessionAccountInfo = await connection.getAccountInfo(gameSessionPda);
        if (!gameSessionAccountInfo) {
            console.error("КРИТИЧЕСКАЯ ОШИБКА: Аккаунт GameSession не найден.");
            return;
        }
        const roundToClaim = new BN(ROUND_TO_CLAIM);
        console.log(`ЛОГ: Принудительно проверяем выигрыши для раунда: ${roundToClaim.toString()}`);
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
            console.log(`\n>>> Этап 2: Найдено ${winnersToClaim.length} победителей. Начинаем последовательную выплату...`);
            let successCount = 0;
            for (const [index, botKeypair] of winnersToClaim.entries()) {
                try {
                    const result = await claimWinForPlayer(botKeypair, roundToClaim, gameSessionPda);
                    if (result?.status === 'success') {
                        successCount++;
                        process.stdout.write(`\rУспешных выплат: ${successCount}/${winnersToClaim.length}...`);
                    }
                } catch (err) {
                    console.error(`\nОшибка при выплате для ${botKeypair.publicKey.toBase58()}: ${err.message}`);
                }
            }
            process.stdout.write('\n');
            console.log(`\nВыплаты завершены. Успешно: ${successCount} из ${winnersToClaim.length}.`);
        } else {
            console.log("\nИНФО: Победители среди ботов в этом раунде не найдены.");
        }
        console.log("\n>>> Скрипт завершил работу.");
    } catch (e) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА в скрипте claimWinnings:", e);
        throw e;
    }
}

main(); 