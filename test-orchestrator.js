// game-orchestrator.js
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const borsh = require('@coral-xyz/borsh');
const axios = require('axios'); // Добавлено для HTTP-запросов
const fs = require('fs'); // Добавлено

const config = require(path.join(__dirname, 'config.js'));
const { 
    COOLDOWN_AFTER_CLOSE_MS // --- ИЗМЕНЕНО: импортируем COOLDOWN_AFTER_CLOSE_MS
} = config;

// --- ИЗМЕНЕНО: Загрузка PROGRAM_ID из IDL, а не из config.js ---
const idl = JSON.parse(fs.readFileSync(path.join(__dirname, 'roulette_game.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);

// Удалены ненужные импорты startNewRound, closeBets, getRandom
const { runBettingBots } = require(path.join(__dirname, 'bots-betting.js'));
const { claimWinnings } = require(path.join(__dirname, 'bot-wins.js'));
const { getConnection, rotateRpc } = require(path.join(__dirname, 'utils', 'connection.js'));
const { sendSlackNotification } = require(path.join(__dirname, 'utils', 'slack-notifier.js'));

const BACKEND_API_URL = 'https://api.0xroulette.com/api'; // URL вашего бэкенда

// --- ИЗМЕНЕНО: Возвращаемся к u8 и карте состояний ---
const ROUND_STATUS_LAYOUT = borsh.struct([
    borsh.publicKey('authority'),
    borsh.u64('current_round'),
    borsh.i64('round_start_time'),
    borsh.u8('round_status'), // Читаем статус как простое число
    borsh.option(borsh.u8(), 'winning_number'),
    borsh.i64('bets_closed_timestamp'),
    borsh.i64('get_random_timestamp'),
    borsh.u8('bump'),
    borsh.option(borsh.publicKey(), 'last_bettor'),
    borsh.u64('last_completed_round'),
]);
const ROUND_STATUS_MAP = ["NotStarted", "AcceptingBets", "BetsClosed", "Completed"];

// --- ИЗМЕНЕНО: Функция теперь использует карту для определения статуса ---
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
                    // --- ИЗМЕНЕНО: Используем COOLDOWN_AFTER_CLOSE_MS из конфига ---
                    console.log(`[Orchestrator] Ставки закрыты. Начинаем ${COOLDOWN_AFTER_CLOSE_MS / 1000}-секундное ожидание перед запросом случайного числа.`);
                    await new Promise(resolve => setTimeout(resolve, COOLDOWN_AFTER_CLOSE_MS));
                    console.log(`[Orchestrator] ${COOLDOWN_AFTER_CLOSE_MS / 1000} секунд прошло. Начинаем процесс запроса случайного числа через API.`);

                    // --- НОВЫЙ БЛОК: Механизм повторных попыток ---
                    let getRandomSuccessful = false;
                    let attempts = 0;
                    const maxAttempts = 3;

                    while (!getRandomSuccessful && attempts < maxAttempts) {
                        attempts++;
                        try {
                            console.log(`[Orchestrator] Попытка ${attempts}/${maxAttempts}: Запрашиваем случайное число...`);
                            await callGetRandomApi();
                            getRandomSuccessful = true;
                            console.log(`[Orchestrator] Попытка ${attempts}/${maxAttempts} успешна.`);
                        } catch (apiError) {
                            console.error(`[Orchestrator] Ошибка при вызове API (попытка ${attempts}/${maxAttempts}):`, apiError.message);
                            if (attempts >= maxAttempts) {
                                const criticalErrorMsg = `[Orchestrator] КРИТИЧЕСКАЯ ОШИБКА: Не удалось получить случайное число после ${maxAttempts} попыток.`;
                                console.error(criticalErrorMsg);
                                await sendSlackNotification(criticalErrorMsg);
                                // Ошибка будет перехвачена внешним try/catch для общей логики обработки
                                throw new Error(criticalErrorMsg);
                            }
                            console.log(`[Orchestrator] Пауза 5 секунд перед следующей попыткой...`);
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }
                    }
                    // --- КОНЕЦ НОВОГО БЛОКА ---

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

                    // --- ИЗМЕНЕНО: Удалено использование COOLDOWN_AFTER_RANDOM_MS ---
                    console.log(`[Orchestrator] Ждем 5 секунд перед новым раундом...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
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