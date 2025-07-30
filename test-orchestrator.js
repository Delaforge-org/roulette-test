// game-orchestrator.js
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const borsh = require('@coral-xyz/borsh');

// --- ИЗМЕНЕНИЕ 1: Правильный импорт конфигурации ---
// Сначала импортируем весь объект config целиком. Это самый надежный способ.
const config = require(path.join(__dirname, 'config.js'));
// Теперь извлекаем нужные нам переменные из этого объекта.
// Обратите внимание: мы используем SYNDICA_RPC, так как именно это имя используется в config.js
const { 
    PROGRAM_ID, 
    SYNDICA_RPC, 
    BETTING_DURATION_MS, 
    COOLDOWN_AFTER_CLOSE_MS, 
    COOLDOWN_AFTER_RANDOM_MS 
} = config;

// --- ИЗМЕНЕНИЕ 2: Правильный импорт функций ботов ---
// Функции в файлах ботов называются `placeBets` и `claimWinnings`.
const { startNewRound, closeBets, getRandom } = require(path.join(__dirname, 'game-actions.js'));
const { placeBets } = require(path.join(__dirname, 'bots-betting.js'));
const { claimWinnings } = require(path.join(__dirname, 'bot-wins.js'));

// --- ИЗМЕНЕНИЕ 3: Передаем правильный URL в Connection ---
// Теперь переменная SYNDICA_RPC гарантированно содержит строку с URL.
const connection = new Connection(SYNDICA_RPC, 'confirmed');

// Схема для декодирования статуса
const ROUND_STATUS_LAYOUT = borsh.struct([
    borsh.u64('current_round'),
    borsh.i64('round_start_time'),
    borsh.u8('round_status'), // 0: NotStarted, 1: AcceptingBets, 2: BetsClosed, 3: Completed
]);
const ROUND_STATUS_MAP = ["NotStarted", "AcceptingBets", "BetsClosed", "Completed"];

/**
 * Получает и декодирует текущий статус раунда из блокчейна.
 */
async function getRoundStatus() {
    const [gameSessionPda] = await PublicKey.findProgramAddress([Buffer.from('game_session')], PROGRAM_ID);
    const accountInfo = await connection.getAccountInfo(gameSessionPda);
    if (!accountInfo) {
        throw new Error("Аккаунт GameSession не найден. Запустите init-game.js");
    }
    // Пропускаем 8 байт дискриминатора
    const decoded = ROUND_STATUS_LAYOUT.decode(accountInfo.data.slice(8));
    return ROUND_STATUS_MAP[decoded.round_status];
}

// Главный бесконечный цикл
async function gameLoop() {
    console.log("ЛОГ: Оркестратор запущен. Получение статуса...");
    while (true) {
        try {
            const status = await getRoundStatus();
            console.log(`[Orchestrator] Текущий статус раунда: ${status}`);

            switch (status) {
                case "Completed":
                case "NotStarted":
                    console.log("[Orchestrator] Начинаем новый раунд...");
                    await startNewRound();
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    break;

                case "AcceptingBets":
                    console.log("[Orchestrator] Идет прием ставок...");
                    placeBets(); // ИЗМЕНЕНО: Вызываем правильную функцию
                    console.log(`[Orchestrator] Ждем ${BETTING_DURATION_MS / 1000} секунд для завершения ставок...`);
                    await new Promise(resolve => setTimeout(resolve, BETTING_DURATION_MS));
                    
                    console.log("[Orchestrator] Время вышло, закрываем ставки...");
                    await closeBets();
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    break;

                case "BetsClosed":
                    console.log(`[Orchestrator] Ставки закрыты. Ждем ${COOLDOWN_AFTER_CLOSE_MS / 1000} секунд...`);
                    await new Promise(resolve => setTimeout(resolve, COOLDOWN_AFTER_CLOSE_MS));

                    console.log("[Orchestrator] Запрашиваем случайное число...");
                    await getRandom();
                    
                    console.log("[Orchestrator] Запускаем ботов для сбора выигрышей...");
                    await claimWinnings(); // ИЗМЕНЕНО: Вызываем правильную функцию
                    console.log(`[Orchestrator] Ждем ${COOLDOWN_AFTER_RANDOM_MS / 1000} секунд перед новым циклом...`);
                    await new Promise(resolve => setTimeout(resolve, COOLDOWN_AFTER_RANDOM_MS));
                    break;
            }
        } catch (error) {
            console.error("[Orchestrator] КРИТИЧЕСКАЯ ОШИБКА в игровом цикле:", error);
            await new Promise(resolve => setTimeout(resolve, 30000)); 
        }
    }
}

gameLoop();