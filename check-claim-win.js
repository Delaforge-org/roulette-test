const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'config.js'));
const BN = require('bn.js');

// --- КОНФИГУРАЦИЯ ТЕСТА ---
const PLAYER_TO_CHECK = '7ckKq4ZqZ2GDvkHEaHtWCe4xez5mPYAivG1h6YMPDJMR';
const ROUND_TO_CLAIM = 4;
const TOKEN_MINT_ADDRESS = '5ei1ggNH5vjdMVvXbAENiehBmwhHhB2v45ddTigVgdUM'; // OLS, взят из API

// --- НАСТРОЙКИ СКРИПТА ---
const WALLETS_BASE_DIR = path.join(__dirname, 'test-wallets');
const PROGRAM_ID = config.PROGRAM_ID;
const connection = new Connection(config.SYNDICA_RPC, 'confirmed');
const idl = JSON.parse(fs.readFileSync(path.join(__dirname, 'roulette_game.json'), 'utf8'));

console.log(`--- Тестовый клейм для игрока: ${PLAYER_TO_CHECK} ---`);
console.log(`Раунд: ${ROUND_TO_CLAIM}`);
console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);

function findWallet(playerPubkey) {
    console.log(`\n1. Поиск кошелька для ${playerPubkey}...`);
    const subdirs = fs.readdirSync(WALLETS_BASE_DIR);
    for (const subdirName of subdirs) {
        const dirPath = path.join(WALLETS_BASE_DIR, subdirName);
        if (fs.statSync(dirPath).isDirectory()) {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(dirPath, file);
                    const keypairData = Uint8Array.from(JSON.parse(fs.readFileSync(filePath)));
                    const keypair = Keypair.fromSecretKey(keypairData);
                    if (keypair.publicKey.toBase58() === playerPubkey) {
                        console.log(`   > Кошелек найден в папке: ${subdirName}`);
                        return keypair;
                    }
                }
            }
        }
    }
    return null;
}

function findInstructionDiscriminator(name) {
    const instruction = idl.instructions.find(ix => ix.name === name);
    if (!instruction) throw new Error(`Инструкция "${name}" не найдена в IDL`);
    return Buffer.from(instruction.discriminator);
}

async function main() {
    try {
        const botKeypair = findWallet(PLAYER_TO_CHECK);
        if (!botKeypair) throw new Error('Кошелек для указанного игрока не найден в test-wallets/');
        
        const playerPubkey = botKeypair.publicKey;
        const roundToClaimBN = new BN(ROUND_TO_CLAIM);

        console.log('\n2. Вычисление всех необходимых адресов (PDA)...');
        
        const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], PROGRAM_ID);
        console.log(`   > GameSession PDA: ${gameSessionPda.toBase58()}`);

        const tokenMint = new PublicKey(TOKEN_MINT_ADDRESS);
        const [vaultPda] = await PublicKey.findProgramAddress([Buffer.from('vault'), tokenMint.toBuffer()], PROGRAM_ID);
        console.log(`   > Vault PDA: ${vaultPda.toBase58()}`);

        const [playerBetsPda] = await PublicKey.findProgramAddress([Buffer.from('player_bets'), gameSessionPda.toBuffer(), playerPubkey.toBuffer()], PROGRAM_ID);
        console.log(`   > PlayerBets PDA: ${playerBetsPda.toBase58()}`);
        
        const [claimRecordPda] = await PublicKey.findProgramAddress([Buffer.from('claim_record'), playerPubkey.toBuffer(), roundToClaimBN.toBuffer('le', 8)], PROGRAM_ID);
        console.log(`   > ClaimRecord PDA: ${claimRecordPda.toBase58()}`);

        const playerAta = await getAssociatedTokenAddress(tokenMint, playerPubkey);
        const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
        if (!vaultAccountInfo) throw new Error(`Не удалось найти аккаунт хранилища (Vault)`);
        const vaultAta = new PublicKey(vaultAccountInfo.data.slice(40, 72));
        console.log(`   > Vault ATA (из хранилища): ${vaultAta.toBase58()}`);
        
        const claimRecordInfo = await connection.getAccountInfo(claimRecordPda);
        if (claimRecordInfo) {
            console.warn(`\nПРЕДУПРЕЖДЕНИЕ: Запись о выигрыше (${claimRecordPda.toBase58()}) уже существует. Выплата была произведена ранее.`);
            return;
        }

        console.log('\n3. Формирование и отправка транзакции...');
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
                roundToClaimBN.toBuffer('le', 8),
            ]),
        });

        const transaction = new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
            .add(claimIx);
        
        const signature = await sendAndConfirmTransaction(connection, transaction, [botKeypair]);

        console.log('\n\n✅✅✅ УСПЕХ! ✅✅✅');
        console.log('Выигрыш успешно получен.');
        console.log(`Cсылка на транзакцию: https://solscan.io/tx/${signature}?cluster=devnet`);

    } catch (error) {
        console.error('\n\n❌❌❌ ОШИБКА! ❌❌❌');
        console.error(error.message);
        if (error.logs) {
            console.error("Логи программы:", error.logs);
        }
    }
}

main();