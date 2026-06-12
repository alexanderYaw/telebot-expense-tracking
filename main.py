import os
import re
import json
import uuid
import hmac
import hashlib
import logging
from http import HTTPStatus
from contextlib import asynccontextmanager
from datetime import datetime
from urllib.parse import parse_qsl
import gspread
from google.oauth2.service_account import Credentials
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.helpers import escape_markdown
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    ConversationHandler, MessageHandler, filters, ContextTypes,
)
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, Depends
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Load environment variables from the .env file
load_dotenv()

# --- CONFIGURATION ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
SPREADSHEET_URL_OR_ID = os.getenv("SPREADSHEET_ID")
GOOGLE_CREDENTIALS_FILE = "service_account.json"

# Webhook (hosted) configuration. On Render, the platform automatically injects
# RENDER_EXTERNAL_URL (the public https URL of the web service) and PORT, so the
# bot picks those up with no manual setup. WEBHOOK_URL can still be set explicitly
# to override (e.g. a custom domain or another host). When neither is present the
# bot falls back to long-polling, which is what you want for local development.
WEBHOOK_URL = os.getenv("WEBHOOK_URL") or os.getenv("RENDER_EXTERNAL_URL")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET")
PORT = int(os.getenv("PORT", "8080"))

if not TELEGRAM_TOKEN:
    raise ValueError("No TELEGRAM_TOKEN found in .env file.")

if not SPREADSHEET_URL_OR_ID:
    raise ValueError("No SPREADSHEET_ID found in .env file.")

# Define your custom categories here
CATEGORIES = ["Food", "Transport", "Shopping", "Groceries", "Bills", "Climbing", "Others"]

# Enable logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GOOGLE SHEETS HELPER ---
class SheetsHelper:
    def __init__(self):
        scopes = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
        creds = self._load_credentials(scopes)
        self.client = gspread.authorize(creds)
        self.sheet = self.client.open_by_key(SPREADSHEET_URL_OR_ID)

    @staticmethod
    def _load_credentials(scopes):
        """Load service-account credentials. Prefers GOOGLE_CREDENTIALS_JSON (the raw
        JSON pasted into a Render env var) so no key file needs to live in the repo or
        image; falls back to the local service_account.json file for development."""
        creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
        if creds_json:
            info = json.loads(creds_json)
            return Credentials.from_service_account_info(info, scopes=scopes)
        return Credentials.from_service_account_file(GOOGLE_CREDENTIALS_FILE, scopes=scopes)

    HEADER = ["ID", "Date", "Type", "Category", "Amount", "Notes", "Recurring"]

    @staticmethod
    def _title_for_month(ym: str) -> str:
        """'2026-06' -> 'Jun_2026', matching the bot's monthly worksheet naming."""
        return datetime.strptime(ym, "%Y-%m").strftime("%b_%Y")

    def _get_or_create_worksheet(self, title: str):
        try:
            return self.sheet.worksheet(title)
        except gspread.exceptions.WorksheetNotFound:
            ws = self.sheet.add_worksheet(title=title, rows="100", cols=str(len(self.HEADER)))
            ws.append_row(self.HEADER)
            return ws

    def _get_current_month_worksheet(self):
        return self._get_or_create_worksheet(datetime.now().strftime("%b_%Y"))

    def add_expense(self, category: str, amount: float, name: str = ""):
        ws = self._get_current_month_worksheet()
        entry_id = str(uuid.uuid4())[:8]
        date_str = datetime.now().strftime("%Y-%m-%d")
        ws.append_row([entry_id, date_str, "Expense", category, amount, name, ""])
        return entry_id

    def list_expenses(self):
        ws = self._get_current_month_worksheet()
        records = ws.get_all_records()
        return records

    def _row_to_expense(self, row_values):
        """Maps a raw worksheet row to an expense dict (Name lives in the Notes column)."""
        return {
            "category": row_values[3] if len(row_values) > 3 else "",
            "amount": row_values[4] if len(row_values) > 4 else "",
            "name": row_values[5] if len(row_values) > 5 else "",
        }

    def delete_last_entry(self):
        ws = self._get_current_month_worksheet()
        total_rows = len(ws.col_values(1))
        if total_rows > 1:
            expense = self._row_to_expense(ws.row_values(total_rows))
            ws.delete_rows(total_rows)
            return expense
        return None

    def get_expense_by_index(self, month: str, index: int):
        try:
            ws = self.sheet.worksheet(month)
        except gspread.exceptions.WorksheetNotFound:
            return None
        records = ws.get_all_records()
        if 1 <= index <= len(records):
            return records[index - 1]
        return None

    def delete_by_index(self, index: int):
        ws = self._get_current_month_worksheet()
        if index < 1:
            return None
        target_row = index + 1
        row_values = ws.row_values(target_row)
        if not row_values:
            return None
        expense = self._row_to_expense(row_values)
        ws.delete_rows(target_row)
        return expense

    def edit_by_index(self, index: int, category: str = None, amount: float = None, name: str = None):
        ws = self._get_current_month_worksheet()
        if index < 1:
            return None
        target_row = index + 1
        if not ws.row_values(target_row):
            return None

        if category is not None:
            ws.update_cell(target_row, 4, category)
        if amount is not None:
            ws.update_cell(target_row, 5, amount)
        if name is not None:
            ws.update_cell(target_row, 6, name)

        # Read the row back so the caller gets the full, up-to-date expense
        return self._row_to_expense(ws.row_values(target_row))

    # --- Web API surface ------------------------------------------------
    # These read/write by month ('YYYY-MM') and ID rather than by row index,
    # so the Mini App can address any month and any row unambiguously.

    @staticmethod
    def _to_web_tx(row):
        """Maps a positional worksheet row to the shape the webapp expects.
        Columns: 0=ID 1=Date 2=Type 3=Category 4=Amount 5=Notes 6=Recurring."""
        def cell(i):
            return row[i] if len(row) > i else ""
        try:
            amount = float(cell(4))
        except (ValueError, TypeError):
            amount = 0.0
        return {
            "id": cell(0),
            "date": cell(1),
            "type": cell(2) or "Expense",
            "category": cell(3),
            "amount": amount,
            "name": cell(5),
            "recurring": str(cell(6)).strip().upper() in ("TRUE", "1", "YES"),
        }

    def get_month(self, ym: str):
        """All transactions for a 'YYYY-MM' month, newest first. [] if no sheet yet."""
        try:
            ws = self.sheet.worksheet(self._title_for_month(ym))
        except gspread.exceptions.WorksheetNotFound:
            return []
        rows = ws.get_all_values()[1:]  # drop header
        txs = [self._to_web_tx(r) for r in rows if any(c.strip() for c in r)]
        txs.sort(key=lambda t: t["date"], reverse=True)
        return txs

    def add_transaction(self, tx_type, amount, name="", category="", date=None, recurring=False):
        """Append a transaction to the worksheet for its date's month and return it."""
        date_str = date or datetime.now().strftime("%Y-%m-%d")
        ym = date_str[:7]
        ws = self._get_or_create_worksheet(self._title_for_month(ym))
        entry_id = str(uuid.uuid4())[:8]
        ws.append_row([
            entry_id, date_str, tx_type, category, amount, name,
            "TRUE" if recurring else "",
        ])
        return {
            "id": entry_id, "date": date_str, "type": tx_type,
            "category": category, "amount": float(amount), "name": name,
            "recurring": bool(recurring),
        }

    def delete_by_id(self, ym: str, entry_id: str):
        """Delete the row whose ID matches in the given month. Returns it, or None."""
        try:
            ws = self.sheet.worksheet(self._title_for_month(ym))
        except gspread.exceptions.WorksheetNotFound:
            return None
        ids = ws.col_values(1)
        for row_num, cell in enumerate(ids[1:], start=2):  # skip header row
            if cell == entry_id:
                deleted = self._to_web_tx(ws.row_values(row_num))
                ws.delete_rows(row_num)
                return deleted
        return None

db = SheetsHelper()

# --- TELEGRAM HANDLERS ---

# Conversation states for the add-expense flow
AWAITING_NAME, AWAITING_CATEGORY = range(2)

async def spend(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /spend [amount] — starts the add-expense flow by asking for a name."""
    # Strict money form only: rejects inf/nan, scientific notation (1e9),
    # underscores (1_000) and >2 decimals that float() would otherwise accept.
    if not context.args or not re.fullmatch(r'\d+(\.\d{1,2})?', context.args[0]):
        await update.message.reply_text("❌ Syntax: /spend [amount]\nExample: /spend 12.50")
        return ConversationHandler.END

    amount = float(context.args[0])
    if amount <= 0:
        await update.message.reply_text("⚠️ Amount must be greater than zero.")
        return ConversationHandler.END
    # Stash the amount so the later steps can use it
    context.user_data['amount'] = amount
    await update.message.reply_text(
        f"💵 Amount: ${amount:.2f}\n📝 Please enter details:"
    )
    return AWAITING_NAME

async def receive_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Captures the expense name, then shows the category buttons."""
    name = update.message.text.strip()
    context.user_data['name'] = name
    amount = context.user_data['amount']

    # Build the button grid dynamically from the CATEGORIES list
    keyboard = []
    row = []
    for cat in CATEGORIES:
        # Only the category travels in the callback_data; name/amount live in user_data
        callback_data = f"setcat|{cat}"
        row.append(InlineKeyboardButton(cat, callback_data=callback_data))

        # Group buttons into rows of 2 for better UI
        if len(row) == 2:
            keyboard.append(row)
            row = []

    # Add any remaining buttons that didn't fit into a pair
    if row:
        keyboard.append(row)

    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(
        f"📝 {name} — ${amount:.2f}\nSelect a category:", reply_markup=reply_markup
    )
    return AWAITING_CATEGORY

async def receive_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Captures the category button press and writes the expense to the sheet."""
    query = update.callback_query

    # Telegram requires you to answer the query to stop the loading animation on the button
    await query.answer()

    _, category = query.data.split("|")
    name = context.user_data.get('name', '')
    amount = context.user_data.get('amount', 0.0)

    # Save to Google Sheets
    db.add_expense(category, amount, name)

    # Replace the button grid with a success message
    await query.edit_message_text(f"✅ Logged: {name} — ${amount:.2f} for {category}")
    context.user_data.clear()
    return ConversationHandler.END

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Aborts the add-expense flow."""
    context.user_data.clear()
    await update.message.reply_text("❌ Cancelled.")
    return ConversationHandler.END

def format_date(date_str):
    """Renders a stored 'YYYY-MM-DD' date as numeric day + month word, e.g. '5 Jun'."""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return f"{dt.day} {dt.strftime('%b')}"
    except (ValueError, TypeError):
        return date_str

def format_expense(expense):
    """Renders an expense dict as 'Name | Category | $Price'."""
    name = expense.get('name') or '(no name)'
    category = expense.get('category', '')
    try:
        amount = f"${float(expense['amount']):.2f}"
    except (ValueError, TypeError, KeyError):
        amount = f"${expense.get('amount', '')}"
    return f"{name} | {category} | {amount}"

async def undo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    expense = db.delete_last_entry()
    if expense:
        await update.message.reply_text(
            f"↩️ Undo successful. Deleted: {format_expense(expense)}"
        )
    else:
        await update.message.reply_text("⚠️ No entries found to delete.")

async def _reply_chunked(message, text, **kwargs):
    """Send `text` split across Telegram's 4096-char limit, breaking on line
    boundaries so each chunk's Markdown entities stay self-contained."""
    MAX = 4096
    if len(text) <= MAX:
        await message.reply_text(text, **kwargs)
        return
    buf = ""
    for line in text.split("\n"):
        if buf and len(buf) + len(line) + 1 > MAX:
            await message.reply_text(buf.rstrip("\n"), **kwargs)
            buf = ""
        buf += line + "\n"
    if buf.strip():
        await message.reply_text(buf.rstrip("\n"), **kwargs)

async def list_month(update: Update, context: ContextTypes.DEFAULT_TYPE):
    records = db.list_expenses()
    if not records:
        await update.message.reply_text("No expenses logged this month.")
        return

    lines = [f"**{datetime.now().strftime('%B %Y')} Expenses**"]
    total = 0.0

    for i, row in enumerate(records, start=1):
        if row.get('Type') != 'Expense':
            continue
        # A single malformed cell must not crash the whole listing.
        try:
            total += float(row['Amount'])
        except (ValueError, TypeError, KeyError):
            pass
        # Escape user-controlled fields so stray markdown chars (e.g. "Mc_Donald")
        # can't break Telegram's Markdown parser and abort the message.
        name = escape_markdown(str(row.get('Notes') or ' '), version=1)
        date = escape_markdown(str(format_date(row.get('Date'))), version=1)
        amount = escape_markdown(str(row.get('Amount', '')), version=1)
        lines.append(f"`[{i}]` ({date}) {name}: ${amount}")

    lines.append(f"\n*Total: ${total:.2f}*")
    await _reply_chunked(update.message, "\n".join(lines), parse_mode='Markdown')

async def remove(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        index = int(context.args[0])
    except (IndexError, ValueError):
        await update.message.reply_text("❌ Syntax: /rm [index]\nExample: /rm 3")
        return

    expense = db.delete_by_index(index)
    if expense:
        await update.message.reply_text(
            f"🗑️ Deleted [{index}]: {format_expense(expense)}"
        )
    else:
        await update.message.reply_text(f"⚠️ No entry found at index [{index}].")

async def edit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    
    id_match = re.search(r'^/edit\s+(\d+)', text, re.IGNORECASE)
    if not id_match:
        await update.message.reply_text("❌ Syntax: /edit [index] c/[category] p/[price] n/[new_name]")
        return

    entry_idx = int(id_match.group(1))

    category_match = re.search(r'c/([a-zA-Z0-9_]+)', text, re.IGNORECASE)
    category = category_match.group(1).capitalize() if category_match else None

    price_match = re.search(r'p/(\d+(?:\.\d{1,2})?)', text, re.IGNORECASE)
    price = float(price_match.group(1)) if price_match else None

    # Capture the new name up to the next flag (allows spaces in names)
    name_match = re.search(r'n/(.+?)(?=\s+[cp]/|$)', text, re.IGNORECASE)
    name = name_match.group(1).strip() if name_match else None

    if category is None and price is None and name is None:
        await update.message.reply_text("⚠️ Provide at least one flag: c/[category], p/[price] or n/[new_name]")
        return

    expense = db.edit_by_index(entry_idx, category, price, name)
    if not expense:
        await update.message.reply_text(f"⚠️ No entry found at index [{entry_idx}].")
        return

    await update.message.reply_text(
        f"✅ Updated [{entry_idx}]: {format_expense(expense)}"
    )

# --- TELEGRAM APPLICATION ---
def build_application():
    # In webhook mode we feed updates in ourselves, so PTB needs no Updater.
    builder = ApplicationBuilder().token(TELEGRAM_TOKEN)
    if WEBHOOK_URL:
        builder = builder.updater(None)
    application = builder.build()

    # Register the multi-step add-expense flow: /spend -> name -> category buttons
    add_expense_conv = ConversationHandler(
        entry_points=[CommandHandler("spend", spend)],
        states={
            AWAITING_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_name)],
            AWAITING_CATEGORY: [CallbackQueryHandler(receive_category, pattern=r"^setcat\|")],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    application.add_handler(add_expense_conv)

    # Register Text Commands
    application.add_handler(CommandHandler("undo", undo))
    application.add_handler(CommandHandler("list", list_month))
    application.add_handler(CommandHandler("rm", remove))
    application.add_handler(CommandHandler("edit", edit))
    return application


application = build_application()

# --- WEB APP AUTH (Telegram Mini App initData validation) ---
# Locally (no WEBHOOK_URL) or with ALLOW_INSECURE_WEBAPP=1 we skip auth so the
# webapp can be previewed in a plain browser, which has no signed initData.
DEV_MODE = (not WEBHOOK_URL) or os.getenv("ALLOW_INSECURE_WEBAPP") == "1"


def validate_init_data(init_data: str):
    """Verify a Mini App's signed initData (HMAC-SHA256 keyed off the bot token).
    Returns the parsed fields on success, else None. See Telegram's
    'Validating data received via the Mini App' spec."""
    if not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret_key = hmac.new(b"WebAppData", TELEGRAM_TOKEN.encode(), hashlib.sha256).digest()
    computed = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed, received_hash):
        return None
    return pairs


async def require_auth(x_telegram_init_data: str = Header(default="")):
    auth = validate_init_data(x_telegram_init_data)
    if auth is None and not DEV_MODE:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return auth


# --- WEB API MODELS ---
VALID_TYPES = {"Expense", "Income", "Incoming"}


def _require_month(month: str) -> str:
    """Validate a 'YYYY-MM' month as a real calendar month, else HTTP 400.
    A plain regex would accept impossible values like 2026-13 or 0000-00,
    which then blow up downstream in strptime (HTTP 500)."""
    try:
        datetime.strptime(month, "%Y-%m")
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="month must be a valid YYYY-MM")
    return month


def _require_date(date: str) -> str:
    """Validate a 'YYYY-MM-DD' date as a real calendar date, else HTTP 400.
    Rejects well-formed impossibilities like 2026-02-30 or 2026-13-99."""
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="date must be a valid YYYY-MM-DD")
    return date


class TxIn(BaseModel):
    type: str
    amount: float
    name: str = ""
    category: str = ""
    date: str | None = None
    recurring: bool = False


# --- FASTAPI APP ---
@asynccontextmanager
async def lifespan(_app: FastAPI):
    await application.initialize()
    await application.start()
    if WEBHOOK_URL:
        webhook_url = f"{WEBHOOK_URL.rstrip('/')}/{TELEGRAM_TOKEN}"
        await application.bot.set_webhook(
            url=webhook_url,
            secret_token=WEBHOOK_SECRET or None,
            drop_pending_updates=True,
            allowed_updates=Update.ALL_TYPES,
        )
        logging.info("Webhook set: %s", webhook_url)
    else:
        await application.updater.start_polling(drop_pending_updates=True)
        logging.info("Bot polling started (local dev).")
    try:
        yield
    finally:
        if not WEBHOOK_URL:
            await application.updater.stop()
        await application.stop()
        await application.shutdown()


app = FastAPI(lifespan=lifespan)


@app.post(f"/{TELEGRAM_TOKEN}")
async def telegram_webhook(request: Request):
    """Receive a Telegram update and hand it to PTB's processing queue."""
    if WEBHOOK_SECRET and request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
    ) != WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")
    data = await request.json()
    await application.update_queue.put(Update.de_json(data, application.bot))
    return Response(status_code=HTTPStatus.OK)


@app.get("/api/transactions")
def api_list(month: str, _auth=Depends(require_auth)):
    _require_month(month)
    return {"transactions": db.get_month(month), "categories": CATEGORIES}


@app.post("/api/transactions")
def api_add(tx: TxIn, _auth=Depends(require_auth)):
    if tx.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")
    if not (tx.amount > 0):
        raise HTTPException(status_code=400, detail="amount must be greater than zero")
    if tx.date is not None:
        _require_date(tx.date)
    created = db.add_transaction(
        tx_type=tx.type,
        amount=round(tx.amount, 2),
        name=tx.name.strip(),
        category=tx.category.strip(),
        date=tx.date,
        recurring=tx.recurring,
    )
    return {"transaction": created}


@app.delete("/api/transactions/{entry_id}")
def api_delete(entry_id: str, month: str, _auth=Depends(require_auth)):
    _require_month(month)
    deleted = db.delete_by_id(month, entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="No entry with that id this month")
    return {"deleted": deleted}


# Serve the Mini App's static files. Mounted last so it doesn't shadow the
# API/webhook routes above. html=True makes "/" serve index.html.
_WEBAPP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webapp")
app.mount("/", StaticFiles(directory=_WEBAPP_DIR, html=True), name="webapp")


if __name__ == "__main__":
    import uvicorn

    mode = "webhook" if WEBHOOK_URL else "polling (local)"
    print(f"Starting server on port {PORT} — Telegram mode: {mode}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)