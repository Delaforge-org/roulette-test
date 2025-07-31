// game-orchestrator.js
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const borsh = require('@coral-xyz/borsh');

const config = require(path.join(__dirname, 'config.js'));
const { 
    PROGRAM_ID, 
    BETTING_DURATION_MS, 
    COOLDOWN_AFTER_CLOSE_MS, 
    COOLDOWN_AFTER_RANDOM_MS 
} = config;

const { startNewRound, closeBets, getRandom } = require(path.join(__dirname, 'game-actions.js'));
const { runBettingBots } = require(path.join(__dirname, 'bots-betting.js'));
const { claimWinnings } = require(path.join(__dirname, 'bot-wins.js'));
const { getConnection, rotateRpc } = require(path.join(__dirname, 'utils', 'connection.js'));
const { sendSlackNotification } = require(path.join(__dirname, 'utils', 'slack-notifier.js'));

const ROUND_STATUS_LAYOUT = borsh.struct([
    borsh.u64('current_round'),
    borsh.i64('round_start_time'),
    borsh.u8('round_status'),
]);
const ROUND_STATUS_MAP = ["NotStarted", "AcceptingBets", "BetsClosed", "Completed"];

// --- ИЗМЕНЕНИЕ 1: Функция теперь возвращает объект ---
async function getRoundStatus() {
    const connection = getConnection();
    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], PROGRAM_ID);
    const accountInfo = await connection.getAccountInfo(gameSessionPda);
    if (!accountInfo) {
        throw new Error("Аккаунт GameSession не найден.");
    }
    const decoded = ROUND_STATUS_LAYOUT.decode(accountInfo.data.slice(8));
    return {
        status: ROUND_STATUS_MAP[decoded.round_status],
        startTime: decoded.round_start_time.toNumber() * 1000 // Конвертируем Unix-время в мс
    };
}

// --- ИЗМЕНЕНИЕ 2: Флаг для отслеживания первого запуска ставок ---
let hasPlacedBetsThisRound = false;

async function gameLoop() {
    console.log("ЛОГ: Оркестратор запущен. Получение статуса...");
    while (true) {
        try {
            const { status, startTime } = await getRoundStatus();
            console.log(`[Orchestrator] Текущий статус раунда: ${status}`);

            switch (status) {
                case "Completed":
                case "NotStarted":
                    hasPlacedBetsThisRound = false; // Сбрасываем флаг для нового раунда
                    console.log("[Orchestrator] Начинаем новый раунд...");
                    await startNewRound();
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    break;

                // --- ИЗМЕНЕНИЕ 3: Новая, умная логика для ставок ---
                case "AcceptingBets":
                    if (!hasPlacedBetsThisRound) {
                        console.log("[Orchestrator] Идет прием ставок, запускаем ботов...");
                        runBettingBots(); // Запускаем, но не ждем завершения
                        hasPlacedBetsThisRound = true;
                    }
                    
                    const timeElapsed = Date.now() - startTime;
                    const timeRemaining = BETTING_DURATION_MS - timeElapsed;

                    if (timeRemaining > 0) {
                        console.log(`[Orchestrator] Ставки уже размещаются. Ожидаем ${Math.round(timeRemaining / 1000)} секунд до закрытия...`);
                        await new Promise(resolve => setTimeout(resolve, timeRemaining));
                    }
                    
                    console.log("[Orchestrator] Время вышло, закрываем ставки...");
                    await closeBets();
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    break;
                // --- КОНЕЦ ИЗМЕНЕНИЙ ---

                case "BetsClosed":
                    console.log(`[Orchestrator] Ставки закрыты. Ждем ${COOLDOWN_AFTER_CLOSE_MS / 1000} секунд...`);
                    await new Promise(resolve => setTimeout(resolve, COOLDOWN_AFTER_CLOSE_MS));
                    console.log("[Orchestrator] Запрашиваем случайное число...");
                    await getRandom();
                    console.log("[Orchestrator] Запускаем ботов для сбора выигрышей...");
                    await claimWinnings();
                    console.log(`[Orchestrator] Ждем ${COOLDOWN_AFTER_RANDOM_MS / 1000} секунд...`);
                    await new Promise(resolve => setTimeout(resolve, COOLDOWN_AFTER_RANDOM_MS));
                    break;
            }
        } catch (error) {
            const errorMessage = error.message || 'Неизвестная ошибка';
            console.error("[Orchestrator] КРИТИЧЕСКАЯ ОШИБКА в игровом цикле:", errorMessage);
            
            // --- ДОБАВЛЯЕМ ВЫЗОВ УВЕДОМЛЕНИЯ ---
            await sendSlackNotification(errorMessage);

            const lowerCaseError = errorMessage.toLowerCase();
            if (lowerCaseError.includes('limit') || lowerCaseError.includes('429') || lowerCaseError.includes('failed to fetch') || lowerCaseError.includes('socket')) {
                await rotateRpc();
                console.log('[Orchestrator] RPC переключен. Пауза 10 секунд...');
                await new Promise(resolve => setTimeout(resolve, 10000));
            } else {
                console.log('[Orchestrator] Неизвестная ошибка. Пауза 30 секунд...');
                await new Promise(resolve => setTimeout(resolve, 30000)); 
            }
        }
    }
}

gameLoop();