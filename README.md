# vk-service-mock

Мок нашего сервиса обмена сообщениями с VK: генерирует **входящие** хуки (как будто
пользователь VK написал в нашу группу) и принимает **исходящие** сообщения
(то, что binder отправляет в сервис). Ведёт собственный учёт аккаунтов, диалогов и
сообщений в SQLite, сам генерирует id, токены и тексты сообщений.

Никакой авторизации нет — это мок, открытый полностью.

```
Node.js >= 22.5 (используется встроенный node:sqlite)  ·  Hono  ·  pnpm  ·  YAML-конфиг
```

## Запуск

```bash
pnpm install         # один раз
pnpm start           # http://127.0.0.1:9680
pnpm dev             # с автоперезапуском (node --watch)
pnpm smoke           # 15 end-to-end проверок API (свой порт и своя временная база)
```

Параметры запуска:

```bash
pnpm start --port 9681 --host 0.0.0.0 --target https://example.com/hook --no-deliver --quiet
```

Переменные окружения: `MOCK_CONFIG`, `MOCK_HOST`, `MOCK_PORT`, `MOCK_DB`,
`MOCK_HOOK_TARGET`, `MOCK_HOOK_DELIVER`, `MOCK_QUIET`.
Конфиг — [config.yaml](config.yaml); чего в нём нет, берётся из значений по умолчанию
в [src/config.js](src/config.js) (там же все дефолты продублированы в виде объекта).

Если порт занят, сервер не падает со стеком, а пишет понятное сообщение и выходит
с кодом 1:

```
Port 127.0.0.1:9680 is already in use — stop the process holding it or start on another port: pnpm start --port 9681
```

При старте сервер печатает таблицу групп с токенами и адресами хуков, а `GET /`
отдаёт индекс всех методов и текущее состояние мока.

## Две стороны работы

| Направление | Кто вызывает | Что делает мок |
|---|---|---|
| **Входящие** — «из VK» | `POST /hook/send`, `POST /hook/batch` | генерирует пейлоад хука, пишет сообщение в базу и **отправляет POST** на `router_base_url` + uuid группы (`binder_path`), либо на `hook.target_url` |
| **Исходящие** — «в VK» | binder → `POST /message/send` (он же `/api/message/send`) | принимает сообщение, находит группу и собеседника, фиксирует в базе, отдаёт `{success, message_id, peer_id}` |

### uuid группы (`binder_path`)

У каждой группы свой uuid в сервисе — это последняя часть адреса, куда сервис
отправляет хуки (`https://b2288router.<домен>/<uuid>`). В моке он хранится в
`binder_path`, отдаётся в `GET /group/{id}` как `uuid` и **обязателен при создании
группы**: выдуманный uuid бесполезен, потому что хуки уйдут в никуда.
Поэтому в конфиге нет ни uuid, ни адреса конкретной группы — есть только
`hook.router_base_url`, а путь подставляется из группы. Значения `user_id`,
`group_id`, `binder_path` и `token` берутся из сервиса (таблица `group_integrations`)
и все четыре обязательны при создании группы — мок ничего из этого не выдумывает.

Чтобы связать реальный сервис с моком, достаточно подставить мок в конфиг binder'а:

```php
$this->config['adapters']['vk-bot']['service_url'] = 'http://127.0.0.1:9680'; // -> /message/send
```

Формат тела — как у настоящего адаптера: `{"login": "<group_id|alias>", "msg": {"to": <peer_id>, "thread": <peer_id>, "text": "..."}}`.
Принимаются и «плоские» варианты: `{"login": "...", "to": "...", "text": "..."}`,
`peer_id`/`peer`/`message`/`group_id`/`group` — синонимы.

## Параметры и алиасы

* `from` / `to` — либо числовой id, либо **alias** из базы (`group01`, `vkuser111`);
  если значение не числовое — ищется по alias, если числовое — сначала по id, потом по alias.
* `to` в хуках — наша группа (если не задан, берётся первая группа из базы).
* `from` в хуках — внешний пользователь VK: если его нет в базе, он создаётся
  (с указанным id/alias либо со сгенерированными).
* Параметры принимаются и в query, и в JSON-теле (`text`/`template` — только в теле).

## Шаблоны сообщений

По умолчанию: `Сообщение от {{id}} {{item}}`.
В тексте можно использовать любое поле контекста: `{{id}}` (id отправителя),
`{{item}}` (номер сообщения в диалоге), `{{datetime}}` (`2026-10-01 12:45:52.1234`, UTC),
`{{from}}`, `{{to}}`, `{{thread}}`, `{{group_id}}`, `{{group_alias}}`, `{{alias}}`,
`{{first_name}}`, `{{last_name}}`, `{{city}}`, `{{screen_name}}`, `{{index}}`/`{{count}}`
(в пачке), `{{random}}`, `{{uuid}}`. Неизвестные подстановки остаются как есть.

Свой текст задаётся параметром `text` (он тоже проходит через шаблонизатор) или `template`.

## API

### Входящие сообщения (хуки)

| Метод | Описание |
|---|---|
| `POST /hook/send` | Одно входящее сообщение. Параметры: `from`, `to`, `text`, `template`, `item`, `outgoing`, `deliver` |
| `POST /hook/batch` | Пачка сообщений. Параметры: `from`, `to`, `count`, `delay` (сек), `text`, `template`, `deliver` |

Без параметров `/hook/send` создаёт нового пользователя VK, пишет ему сообщение в
первую группу и отправляет хук на `hook.target_url`.
В ответе — всё, что сгенерировано: группа, пользователь, диалог, сообщение,
отправленный пейлоад и результат доставки.

```bash
# новое сообщение от существующего пользователя (или нового, если такого нет)
curl -X POST 'http://127.0.0.1:9680/hook/send?from=vkuser111&to=group01'

# полностью новый пользователь + свой шаблон, без отправки хука
curl -X POST http://127.0.0.1:9680/hook/send -H 'Content-Type: application/json' \
     -d '{"to":"group01","text":"Привет {{first_name}} из {{city}} — {{datetime}}","deliver":false}'

# 6 сообщений с интервалом 2 секунды
curl -X POST http://127.0.0.1:9680/hook/batch -H 'Content-Type: application/json' \
     -d '{"to":"group01","count":6,"delay":2}'
```

В `batch` к тексту всегда добавляется ` [batch 2/6]`, а `delay` — пауза между сообщениями.
Если `count`/`delay`/`text` не заданы, берутся значения из секции `batch` конфига.

### Наши аккаунты (группы)

| Метод | Описание |
|---|---|
| `POST /group/add` | Создать группу. **Обязательны** `user_id`, `group_id`, `binder_path` (uuid) и `token`. Дополнительно: `alias`, `email`, `callbacks`, `confirmation_code`, `server_id`, `is_server_configured` — чего нет, генерируется |
| `GET /group/list` | Список групп |
| `GET /group/{group_id\|alias}` | Все поля группы, включая **token** и **uuid** (`binder_path`) |
| `POST /group/update/{group_id\|alias}` | Частичное обновление: `token`, `user_id`, `binder_path`/`uuid`, `alias`, `email`, `callbacks`, `server_id`, `confirmation_code`, `is_server_configured` |
| `POST /group/delete` и `POST /group/delete/{group_id\|alias}` | Удалить группу |

```bash
# user_id, group_id, binder_path и token — из сервиса (таблица group_integrations)
curl -X POST http://127.0.0.1:9680/group/add -H 'Content-Type: application/json' -d '{
  "alias": "group01",
  "user_id": "bapi88",
  "group_id": 13663696,
  "binder_path": "3fbd2115-5801-41f9-8009-2e5ed11d51be",
  "token": "vk1.a.xxxxxxxx"
}'
curl http://127.0.0.1:9680/group/group01
```

Без любого из четырёх обязательных параметров — `400` со списком того, чего не хватает.
Мок генерирует только `alias` (если не задан) и `confirmation_code`/`email`/`callbacks`
из `group_defaults`. Повторный `binder_path` или `group_id` — `409`.

Если группа уже создана, а поле поправить нужно (например, токен был выдуман старой
версией мока) — пересоздавать не обязательно:

```bash
curl -X POST http://127.0.0.1:9680/group/update/group01 -H 'Content-Type: application/json' \
     -d '{"token":"vk1.a.настоящий-токен"}'
```

### Пользователи VK

| Метод | Описание |
|---|---|
| `POST /vk-user/add` | Создать пользователя. `id`, `alias`, `first_name`, `last_name`, `city`, `sex`, `screen_name` — необязательны |
| `GET /vk-user/list` | Список пользователей |
| `GET /vk-user/{id\|alias}` | Все поля пользователя |
| `POST /vk-user/delete/{id\|alias}` | Удалить пользователя |

Незаданные имя/фамилия генерируются (с учётом пола), город — случайный из
`generator.cities`, `screen_name` — `id{id}`.

### Исходящие сообщения

| Метод | Описание |
|---|---|
| `POST /message/send` (и `/api/message/send`) | Принять исходящее сообщение от binder'а |
| `GET /message/list` | Сообщения. Фильтры: `group`, `peer`, `chat`, `direction`, `limit`, `offset`, `order` |
| `GET /message/{id}` | Одно сообщение (внутренний id мока) |
| `GET /chat/list` | Диалоги (фильтр `group`) |
| `GET /chat/{chat}` | Диалог + последние сообщения |

```bash
curl -X POST http://127.0.0.1:9680/message/send -H 'Content-Type: application/json' \
     -d '{"login":"group01","msg":{"to":"vkuser111","text":"Ответ из binder"}}'
```

Ошибки (как у настоящего сервиса — с `success: false`):

* `400` — нет `login` (`Invalid message format: missing login`) или нет `to`/`thread`;
* `404` — группы нет в базе мока (`Group not found for login ...`);
* `404` — собеседника нет в базе (`VK user not found: ...`).
  Поведение настраивается: `messages.require_known_peer: false` или
  `messages.auto_create_peer: true` — тогда пользователь создаётся на лету.

### Служебные

| Метод | Описание |
|---|---|
| `GET /` | Индекс методов, конфиг, группы с токенами, счётчики |
| `GET /health` | Проверка живости |
| `GET /stats` | Количество групп/пользователей/диалогов/сообщений |
| `POST /reset` | Очистить базу и заново создать seed (`{"seed":false}` — без seed) |

## Конфиг

```yaml
server:   { host: 127.0.0.1, port: 9680, public_url: ..., allow_reset: true, quiet: false }
database: { path: ./data/vk-mock.sqlite }
hook:
  target_url: null                                   # фиксированный url; можно {{binder_path}}
  router_base_url: https://b2288router.developtech.ru # сюда подставляется uuid группы
  deliver: true                # false — только писать в базу
  source: vk-bot
  hook_type: message
  text_template: "Сообщение от {{id}} {{item}}"
batch:    { count: 5, delay: 1, max_count: 200, from: null, to: null, text: null }
messages: { require_known_peer: true, auto_create_peer: false }
generator: { cities: [...], first_names_*: [...], last_names_*: [...], vk_user_id: {...}, aliases: {...} }
group_defaults: { email: ..., confirmation_code: null, callbacks: ..., ... }   # значения по умолчанию для /group/add
seed:     { groups: [], vk_users: [{alias: vkuser111}] }
```

* `hook.router_base_url: https://router.host` → хук уйдёт на
  `https://router.host/<uuid группы>` (как это делает настоящий сервис).
  Никакого uuid конкретной группы в конфиге нет — он у каждой свой.
* `hook.target_url` нужен, только если адрес не собирается из uuid. В нём можно
  использовать `{{binder_path}}`/`{{uuid}}`, `{{group_id}}`, `{{user_id}}`, `{{alias}}`,
  например `https://router.host/webhook/{{binder_path}}`.
* `deliver: false` или `deliver=false` в запросе — сообщение только фиксируется в базе,
  наружу ничего не уходит (удобно, когда нет поднятого получателя).
* Публикация мока на домене: поменяйте `server.host: 0.0.0.0` и `server.public_url`.
* Секция `seed` наполняет базу при первом запуске. Группы в ней задаются целиком —
  `user_id`, `group_id`, `binder_path`, `token` (иначе группа не создастся, в лог уйдёт warn):

  ```yaml
  seed:
    groups:
      - alias: group01
        user_id: bapi88
        group_id: 13663696
        binder_path: 3fbd2115-5801-41f9-8009-2e5ed11d51be
        token: vk1.a.xxxxxxxx
  ```

## База

SQLite (`node:sqlite`), файл из `database.path`. Таблицы повторяют боевые:

* `group_integrations` — наши аккаунты (`user_id`, `group_id`, `token`,
  `confirmation_code`, `callbacks`, `binder_path`, …) плюс mock-поле `alias`;
* `vk_user` — внешние пользователи (плюс `alias` и `created_at`/`updated_at`);
* `chats` — диалоги «группа ↔ пользователь» (`last_item` — последний
  `conversation_message_id`, счётчик сообщений);
* `messages` — все входящие и исходящие сообщения: направление, `from_id`/`to_id`,
  `item`, текст, отправленный/принятый JSON, результат доставки хука.

## Структура

```
src/config.js        загрузка и валидация YAML, дефолты, env-оверрайды
src/db.js            схема SQLite
src/repository.js    запросы, генерация записей, поиск по id/alias
src/generators.js    id, alias, токены, имена, города
src/template.js      шаблоны {{...}} и формат даты-времени
src/hooks.js         сборка пейлоада хука и его доставка
src/routes/*.js      hook, group, vk-user, message, chat, system
src/server.js        сборка приложения и запуск HTTP
src/index.js         CLI-точка входа, баннер, graceful shutdown
scripts/smoke.mjs    end-to-end проверки
examples/api.http    готовые запросы (REST Client / импорт в Bruno)
```

Пейлоад хука совпадает с тем, что реальный сервис отправляет в binder:

```json
{
  "from": 229313008, "to": 13663696, "time": 1790709522000106,
  "text": "Сообщение", "source": "vk-bot", "thread": 229313108,
  "item": "1", "outgoing": false, "replyTo": null, "content": [],
  "hook_type": "message",
  "vkUser": { "id": 229313008, "first_name": "Имя", "last_name": "Фамилия",
              "screen_name": "id229313008", "sex": 1, "city": "Санкт-Петербург" }
}
```

`time` — микросекунды (`date * 1_000_000`), `item` — строка, как в настоящем сервисе.
