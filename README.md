# Department Subscription Telegram Bot

A Telegram bot that lets children subscribe to up to **2 departments** out of **25**. Each department has a capacity of **25** children. The bot records name, surname, and chosen departments, and enforces capacity limits.

## Setup

1. **Create a bot** in Telegram: open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the steps, and copy the token.

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure**
   - Copy `.env.example` to `.env`
   - Put your bot token in `.env`:
     ```
     BOT_TOKEN=123456:ABC-DEF...
     ```

4. **Run**
   ```bash
   npm start
   ```
   For development with auto-restart: `npm run dev`

## Running in Docker

1. **Create `.env`** (same as above: `BOT_TOKEN` and optional Google Sheets vars).

2. **Build and run**
   ```bash
   docker compose up --build -d
   ```
   Logs: `docker compose logs -f bot`

3. **Data persistence**  
   Registrations are stored in `./data`. The Compose file mounts `./data` into the container so data survives restarts.

4. **Using a Google key file in Docker**  
   If you use `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` instead of `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`, mount the key into the container. In `docker-compose.yml`, add under `volumes`:
   ```yaml
   - ./path/to/your-key.json:/app/google-key.json:ro
   ```
   and set in `.env`: `GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/app/google-key.json`.

5. **Stop**
   ```bash
   docker compose down
   ```

## Flow

- **Child** opens the bot and sends `/start`.
- **View departments**: `/departments` — lists directions and free slots.
- **Subscribe**: `/subscribe` — the bot remembers the child by Telegram user ID.  
  - **First time:** asks for name and surname, then choice of 2 departments.  
  - **Already registered:** does *not* ask name or surname again; goes straight to choosing 2 directions (to change subscription).
- **My subscription**: `/my` — shows the child’s current registration.

Capacity is checked when choosing departments; full departments are not selectable. Data is stored in `data/registrations.json` and optionally synced to Google Sheets.

## Admin mode

If `ADMIN_COMMAND` and `ADMIN_PASSWORD` are set in `.env`, the bot has an admin mode:

1. Send the **secret command** (e.g. `/admin_secret` — the value of `ADMIN_COMMAND`).
2. When asked, enter the **admin password** (`ADMIN_PASSWORD`).
3. After that you get an admin menu (session lasts 60 minutes). You can:
   - **Список по направлениям** — list of subscribed children grouped by department.
   - **Выбрать ребёнка** — pick a child from the list, then see their details, **Изменить запись** (re-subscribe to 2 new departments), or **Удалить запись** (unsubscribe).
   - **Управление направлениями** — create, edit, or delete departments:
     - **Добавить направление** — enter name and optional description (new department, capacity 25).
     - **Редактировать описание** — pick a department and set or change its description.
     - **Удалить направление** — pick a department to delete. All children subscribed to that department are automatically unsubscribed from it (their other subscriptions stay). The bot sends each affected child a notification that the direction is no longer available and they can re-subscribe via /subscribe.
   - **Выход** — exit admin mode.

Example `.env`:

```env
ADMIN_COMMAND=/admin_secret
ADMIN_PASSWORD=your_secure_password
```

## Storing in Google Sheets

Registrations can be appended to a Google Sheet so you can view or share them in a spreadsheet (or export/print).

1. **Create a Google Cloud project and enable the Sheets API**
   - Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Enable **Google Sheets API**.

2. **Create a service account**
   - APIs & Services → Credentials → Create Credentials → Service account.
   - Create the account, then open it → Keys → Add key → Create new key → JSON. Download the JSON file.

3. **Create the spreadsheet**
   - In [Google Sheets](https://sheets.google.com), create a new spreadsheet.
   - Copy the **spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
   - Share the spreadsheet with the **service account email** (from the JSON, e.g. `something@project.iam.gserviceaccount.com`) as **Editor**. You don’t need to create a sheet tab—the bot will do it.

4. **Configure the bot**
   - In `.env` set:
     - `GOOGLE_SHEETS_ID=<SPREADSHEET_ID>`
     - Either `GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./path/to/your-key.json`  
       or paste the whole JSON key as one line in `GOOGLE_SERVICE_ACCOUNT_KEY_JSON=...`

5. **Run the bot**
   - On startup the bot **initializes the Google Sheet** when configured:
     - **Registrations** sheet: one tab with columns Name, Surname, Department 1, Department 2, Telegram User ID, Date (all subscriptions).
     - **One sheet per department**: a separate tab for each department, named after the department (e.g. "Art & Crafts", "Music"). Each has a members table with columns **Name**, **Surname**, **Telegram User ID**, **Subscribed at**, listing the children who subscribed to that department.
   - Every new or updated subscription appends a row to **Registrations** and one row to each of the two chosen **department sheets**. The bot still keeps `data/registrations.json` as the source of truth for capacity and in-bot behaviour.

## Departments (data/departments.json)

The list of departments is stored in **`data/departments.json`**. On first run, it is created from:

- **`svod.csv`** in the project root (if present): column **«Название активности»** for names, **«Описание в формате рекламного объявления»** for descriptions.
- Otherwise, the built‑in list of 25 directions in `src/config/departments.js` is used.

After that, admins can **add**, **edit description**, and **delete** departments from the admin menu. Descriptions are shown to children via **/about** or **/описания**. When a department is deleted, all subscriptions to it are removed and affected children receive a notification that they can re-subscribe to other directions via /subscribe.

## Data

- **Departments**: `data/departments.json` (created on first run from CSV or default). Each entry: `id`, `name`, `description` (optional), `capacity`. Admins can change it via the bot.
- **Registrations**: `data/registrations.json` (created automatically). Each record: `telegramUserId`, `name`, `surname`, `departmentIds` (array of 2), and timestamps.
- **Google Sheets** (optional): the bot creates a **Registrations** sheet (all subscriptions) and one sheet per department (name = department name) with a members table (Name, Surname, Telegram User ID, Subscribed at). Each subscription is appended to Registrations and to both chosen department sheets.
