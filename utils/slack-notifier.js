const axios = require('axios');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.js'));

async function sendSlackNotification(message) {
    if (!config.SLACK_WEBHOOK_URL) {
        console.warn('[SlackNotifier] SLACK_WEBHOOK_URL не настроен. Уведомление не отправлено.');
        return;
    }

    try {
        const payload = {
            text: `🚨 *Критическая ошибка в Roulette Orchestrator* 🚨\n\n\`\`\`\n${message}\n\`\`\``
        };
        await axios.post(config.SLACK_WEBHOOK_URL, payload, {
            headers: { 'Content-type': 'application/json' }
        });
        console.log('[SlackNotifier] Уведомление об ошибке успешно отправлено в Slack.');
    } catch (error) {
        console.error('[SlackNotifier] Не удалось отправить уведомление в Slack:', error.message);
    }
}

module.exports = {
    sendSlackNotification,
}; 