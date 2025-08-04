#!/usr/bin/env bash
set -euo pipefail

# --- Настройка ---
# Убедитесь, что ваш solana CLI настроен на devnet и использует кошелек, 
# на котором есть все необходимые токены для раздачи.
# Пример:
# solana config set --url https://api.devnet.solana.com
# solana config set --keypair ~/.config/solana/id.json

# Перейти в директорию, где находится скрипт
cd "$(dirname "$0")"

WALLETS_PER_GROUP=50

# Проверяем флаг принудительной раздачи
FORCE_DISTRIBUTE=false
if [[ "${1:-}" == "--force" ]] || [[ "${1:-}" == "-f" ]]; then
  FORCE_DISTRIBUTE=true
  echo "🔥 ПРИНУДИТЕЛЬНАЯ РАЗДАЧА: Игнорируем файлы-маркеры .funded"
fi

# --- Конфигурация токенов ---
# Ассоциативный массив: ТИКЕР -> АДРЕС МИНТА
declare -A MINTS=(
  [GRN]=DhsFPhLMN1Bq8YQorjZZrYkZoZGHZxc6eemS3zzW5SCu
  [MAR]=E3GVbwcczoM6HJnWHR1NJ2bJbpB5kDDTYqNpusEUec8M
  [SAO]=GyGq8CNEJuY6Dmefjut2jBCEuVAaFyBHCiqdUboHKXcS
  [LOI]=Fvmu22STa3mYx2bHQHMeiSGYYCjtuAsMLFsVpNWuRwcJ
  [USDC]=4FiYqUg9gw5wyQ2po9RGp3EXZns48ZUD4quMwq53sdwT
  [OLS]=5ei1ggNH5vjdMVvXbAENiehBmwhHhB2v45ddTigVgdUM
)

# Ассоциативный массив: ТИКЕР -> Количество знаков после запятой (DECIMALS)
declare -A DECIMALS=(
  [GRN]=9
  [MAR]=6
  [SAO]=6
  [LOI]=6
  [USDC]=6
  [OLS]=6
)

echo "=== Начало раздачи токенов ==="

for ticker in "${!MINTS[@]}"; do
  mint=${MINTS[$ticker]}
  decimals=${DECIMALS[$ticker]}
  
  echo ""
  echo "=== Проверка баланса токена $ticker ($mint) ==="
  
  # Получаем текущий баланс токена на кошельке
  balance_output=$(spl-token balance "$mint" --url https://solana-devnet.api.syndica.io/api-key/4djv6PYW55oz2xsz6fbdJJgKe5oAwj6cf8nRDgPMuXr3npvTQ6oxRkg45Nw7wgEaE63AhewBW7MaSTeU8JPv3gK6TfkfXufPDoM 2>/dev/null || echo "0")
  total_amount=$(echo "$balance_output" | head -n1 | awk '{print $1}')
  
  # Проверяем, что баланс больше нуля
  if [[ "$total_amount" == "0" ]] || [[ -z "$total_amount" ]]; then
    echo "⚠️  ПРЕДУПРЕЖДЕНИЕ: У вас нет токенов $ticker на балансе, пропускаем."
    continue
  fi
  
  # Вычисляем количество токенов на один кошелек (целое число)
  amount_per_wallet=$(echo "$total_amount / $WALLETS_PER_GROUP" | bc)
  
  # Проверяем, что получается хотя бы 1 токен на кошелек
  if [[ "$amount_per_wallet" == "0" ]]; then
    echo "⚠️  ПРЕДУПРЕЖДЕНИЕ: Недостаточно токенов $ticker для распределения по $WALLETS_PER_GROUP кошелькам (доступно: $total_amount), пропускаем."
    continue
  fi

  echo "Найден баланс: $total_amount $ticker. Будет распределено по $amount_per_wallet токенов на каждый из $WALLETS_PER_GROUP кошельков."

  addr_file="$ticker/addresses.txt"
  if [[ ! -f "$addr_file" ]]; then
    echo "КРИТИЧЕСКАЯ ОШИБКА: Файл с адресами не найден: $addr_file" >&2
    echo "Сначала запустите generate-wallets.sh" >&2
    exit 1
  fi

  # Проверяем, существует ли файл-маркер о пополнении.
  # Если да и нет флага --force, то пропускаем эту группу.
  if [[ -f "$ticker/.funded" ]] && [[ "$FORCE_DISTRIBUTE" == "false" ]]; then
    echo "--- Группа $ticker уже была пополнена, пропускаем. Используйте --force для принудительной раздачи. ---"
    continue
  fi

  num_wallets=$(wc -l < "$addr_file")
  i=0

  while read -r recipient; do
    i=$((i+1))
    printf "\nТранзакция %d/%d: Отправка %s $ticker на %s... " "$i" "$num_wallets" "$amount_per_wallet" "$recipient"
    
    # Выполняем перевод
    spl-token transfer \
      "$mint" \
      "$amount_per_wallet" \
      "$recipient" \
      --fund-recipient \
      --allow-unfunded-recipient \
      --url https://solana-devnet.api.syndica.io/api-key/4djv6PYW55oz2xsz6fbdJJgKe5oAwj6cf8nRDgPMuXr3npvTQ6oxRkg45Nw7wgEaE63AhewBW7MaSTeU8JPv3gK6TfkfXufPDoM \
      --fee-payer ~/.config/solana/id.json # Укажите здесь путь к вашему основному кошельку
      
    echo "OK"
    sleep 0.5 
  done < "$addr_file"

  # Создаем файл-маркер, чтобы не пополнять повторно
  touch "$ticker/.funded"

done

echo ""
echo "🎉 Раздача всех токенов завершена!"