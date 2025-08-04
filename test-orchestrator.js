// game-orchestrator.js
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const borsh = require('@coral-xyz/borsh');
const axios = require('axios'); // Добавлено для HTTP-запросов

const config = require(path.join(__dirname, 'config.js'));
const { 
    PROGRAM_ID, 
    COOLDOWN_AFTER_RANDOM_MS 
} = config;

// Удалены ненужные импорты startNewRound, closeBets, getRandom
const { runBettingBots } = require(path.join(__dirname, 'bots-betting.js'));
const { claimWinnings } = require(path.join(__dirname, 'bot-wins.js'));
const { getConnection, rotateRpc } = require(path.join(__dirname, 'utils', 'connection.js'));
const { sendSlackNotification } = require(path.join(__dirname, 'utils', 'slack-notifier.js'));

const BACKEND_API_URL = 'http://localhost:3000/api'; // URL вашего бэкенда

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
        // startTime больше не нужен оркестратору
    };
}

// Новая функция для вызова API
async function callGetRandomApi() {
    try {
        console.log(`[Orchestrator] Вызов POST ${BACKEND_API_URL}/get-random`);
        const response = await axios.post(`${BACKEND_API_URL}/get-random`);
        console.log('[Orchestrator] Успешный вызов API для получения случайного числа:', response.data);
        return response.data;
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('[Orchestrator] Ошибка при вызове API для получения случайного числа:', errorMessage);
        // Пробрасываем ошибку, чтобы ее обработал основной цикл
        throw new Error(`API call to /get-random failed: ${errorMessage}`);
    }
}

// --- ИЗМЕНЕНИЕ 2: Флаг для отслеживания первого запуска ставок ---
let hasPlacedBetsThisRound = false;

async function gameLoop() {
    console.log("ЛОГ: Оркестратор запущен. Получение статуса...");
    while (true) {
        try {
            const { status } = await getRoundStatus();
            console.log(`[Orchestrator] Текущий статус раунда: ${status}`);

            switch (status) {
                case "Completed":
                case "NotStarted":
                    hasPlacedBetsThisRound = false; // Сбрасываем флаг для нового раунда
                    console.log("[Orchestrator] Ожидаем начала нового раунда от бэкенда...");
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Пауза перед следующей проверкой
                    break;

                case "AcceptingBets":
                    if (!hasPlacedBetsThisRound) {
                        console.log("[Orchestrator] Идет прием ставок, запускаем ботов...");
                        // Запускаем, но не ждем завершения
                        runBettingBots().catch(err => {
                            const errorMessage = err.message || 'Неизвестная ошибка';
                            console.error('[Orchestrator] КРИТИЧЕСКАЯ ОШИБКА в фоновом процессе размещения ставок:', errorMessage);
                            sendSlackNotification(`Критическая ошибка в bots-betting.js: ${errorMessage}`);
                        });
                        hasPlacedBetsThisRound = true;
                    }
                    console.log("[Orchestrator] Ставки размещаются. Ожидаем закрытия раунда от бэкенда...");
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Пауза перед следующей проверкой
                    break;

                case "BetsClosed":
                    console.log(`[Orchestrator] Ставки закрыты. Ожидание 16 секунд для запроса случайного числа...`);
                    await new Promise(resolve => setTimeout(resolve, 16000));

                    console.log("[Orchestrator] Запрашиваем случайное число через API...");
                    await callGetRandomApi();
                    
                    // Блок сбора выигрышей остается без изменений
                    console.log("[Orchestrator] Переход в режим сбора выигрышей...");
                    let claimsSuccessful = false;
                    while (!claimsSuccessful) {
                        try {
                            await claimWinnings();
                            claimsSuccessful = true; // Если ошибок не было, выходим из цикла
                            console.log("[Orchestrator] Сбор выигрышей успешно завершен.");
                        } catch (claimError) {
                            const errorMessage = claimError.message || 'Неизвестная ошибка';
                            console.error("[Orchestrator] ОШИБКА при сборе выигрышей:", errorMessage);
                            
                            // Отправляем уведомление в Slack о проблеме со сбором
                            await sendSlackNotification(`Ошибка при сборе выигрышей: ${errorMessage}`);
                            
                            // Логика повторных попыток с разными задержками
                            const lowerCaseError = errorMessage.toLowerCase();
                             if (lowerCaseError.includes('limit') || lowerCaseError.includes('429') || lowerCaseError.includes('failed to fetch') || lowerCaseError.includes('socket')) {
                                await rotateRpc();
                                console.log('[Orchestrator] RPC переключен. Пауза 30 секунд перед повторной попыткой сбора...');
                                await new Promise(resolve => setTimeout(resolve, 30000));
                            } else {
                                console.log('[Orchestrator] Неизвестная ошибка сбора. Пауза 60 секунд перед повторной попыткой...');
                                await new Promise(resolve => setTimeout(resolve, 60000)); 
                            }
                        }
                    }
                    // --- КОНЕЦ НОВОГО БЛОКА ---

                    console.log(`[Orchestrator] Ждем ${COOLDOWN_AFTER_RANDOM_MS / 1000} секунд перед новым раундом...`);
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