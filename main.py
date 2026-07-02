import os
import io
import re
import json
import math
import time
import hmac
import hashlib
import asyncio
import logging
from http import HTTPStatus
from contextlib import asynccontextmanager
from datetime import datetime
from urllib.parse import parse_qsl
from openpyxl import Workbook
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputFile
from telegram.error import TelegramError, RetryAfter
from telegram.helpers import escape_markdown
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    ConversationHandler, MessageHandler, filters, ContextTypes,
)
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, Depends
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from db import Store, init_schema

# Load environment variables from the .env file
load_dotenv()

# --- CONFIGURATION ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")

# Webhook (hosted) configuration. On Render, the platform automatically injects
# RENDER_EXTERNAL_URL (the public https URL of the web service) and PORT, so the
# bot picks those up with no manual setup. WEBHOOK_URL can still be set explicitly
# to override (e.g. a custom domain or another host). When neither is present the
# bot falls back to long-polling, which is what you want for local development.
WEBHOOK_URL = os.getenv("WEBHOOK_URL") or os.getenv("RENDER_EXTERNAL_URL")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET")
PORT = int(os.getenv("PORT", "8080"))

# Admin IDs. The bot is open self-serve (anyone may use it; data is isolated per
# user in Postgres), so this is NO LONGER an access gate — it's the set of admins
# allowed to run /ban, /unban and /stats. Read from the ALLOWED_USER_IDS env var.
ADMIN_USER_IDS = {
    int(x) for x in os.getenv("ALLOWED_USER_IDS", "").replace(" ", "").split(",") if x
}

# Local preview only: in DEV_MODE the Mini App has no signed initData, so requests
# carry no real user. Fall back to this id (defaults to the first admin) so the
# webapp still works against a dev database when opened in a plain browser.
DEV_USER_ID = int(os.getenv("DEV_USER_ID", str(next(iter(ADMIN_USER_IDS), 0))))

if not TELEGRAM_TOKEN:
    raise ValueError("No TELEGRAM_TOKEN found in .env file.")

# Enable logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# Postgres-backed per-user store (system of record).
store = Store()

# --- USER ID ENCRYPTION ------------------------------------------------------
# We never persist a raw Telegram user/chat id. Each id is run through a keyed,
# reversible cipher and the resulting token is what the DB stores (as the tenant
# key, FKs and clear bookmark). It must be reversible because in a private chat the
# user_id *is* the chat_id, and the nightly clear has to recover it to message the
# user. This is a small balanced Feistel network over a 62-bit domain (two 31-bit
# halves) with HMAC-SHA256 as the round function — no external crypto dependency.
#
# The key comes from USER_ID_SECRET. In production (hosted, WEBHOOK_URL set) it is
# REQUIRED — we refuse to silently fall back to the bot token, because if the key ever
# changes (you set USER_ID_SECRET later, or rotate the token) every stored token
# becomes undecodable and all rows are orphaned. Locally it falls back to the token
# for convenience. CHANGING THE KEY ORPHANS ALL EXISTING ROWS — keep it stable.
_USER_ID_SECRET = os.getenv("USER_ID_SECRET")
if not _USER_ID_SECRET:
    if WEBHOOK_URL:
        raise RuntimeError(
            "USER_ID_SECRET must be set in production: it keys the reversible user-id "
            "encryption, and changing it later orphans every stored row. Set a dedicated, "
            "stable secret (do not rely on the bot token)."
        )
    _USER_ID_SECRET = TELEGRAM_TOKEN  # local dev convenience only
_ID_KEY = hashlib.sha256(_USER_ID_SECRET.encode()).digest()
_ID_HALF = 31
_ID_HALF_MASK = (1 << _ID_HALF) - 1
_ID_ROUNDS = 4

def _id_round(i: int, x: int) -> int:
    digest = hmac.new(_ID_KEY, bytes([i]) + x.to_bytes(4, "big"), hashlib.sha256).digest()
    return int.from_bytes(digest[:4], "big") & _ID_HALF_MASK

def encode_id(real_id: int) -> int:
    """Map a real Telegram id to its reversible storage token. Deterministic, so the
    same user always resolves to the same row. Telegram ids are < 2^52, well inside
    the 62-bit domain; the token is a non-negative int that fits a signed BIGINT."""
    n = int(real_id)
    left, right = (n >> _ID_HALF) & _ID_HALF_MASK, n & _ID_HALF_MASK
    for i in range(_ID_ROUNDS):
        left, right = right, left ^ _id_round(i, right)
    return (left << _ID_HALF) | right

def decode_id(token: int) -> int:
    """Inverse of encode_id: recover the real Telegram id (= chat_id) from a token."""
    n = int(token)
    left, right = (n >> _ID_HALF) & _ID_HALF_MASK, n & _ID_HALF_MASK
    for i in reversed(range(_ID_ROUNDS)):
        left, right = right ^ _id_round(i, left), left
    return (left << _ID_HALF) | right

# Money validation shared by the bot, the /api transaction route and the budget
# endpoints. The store columns are NUMERIC(12,2), so a value must be finite,
# positive and within range; centralising this keeps a bad number a clean 400 /
# friendly message instead of a 500 or a wedged conversation.
MAX_AMOUNT = 9_999_999_999.99  # largest value NUMERIC(12,2) can hold

def clean_amount(amount, label="amount"):
    """Return `amount` rounded to cents if it's a valid money value, else raise
    ValueError(message). Rejects None, NaN, ±inf, <= 0, and values past NUMERIC(12,2)."""
    if amount is None or not math.isfinite(amount) or amount <= 0:
        raise ValueError(f"{label} must be greater than zero")
    value = round(amount, 2)
    if value > MAX_AMOUNT:
        raise ValueError(f"{label} must be at most {MAX_AMOUNT:,.2f}")
    return value

# '|' is the bot's category callback_data delimiter, so disallow it; keep names
# short enough to stay well under Telegram's 64-byte callback_data limit.
# "Incoming" is reserved: the webapp uses it as a built-in pseudo-category to group
# received payments (type 'Incoming') in the Categories tab, so a user-created
# expense category of the same name would collide with that filter.
RESERVED_CATEGORIES = {"incoming"}

def clean_category(name):
    """Return a trimmed category name, or raise ValueError if invalid."""
    name = (name or "").strip()
    if not name or len(name) > 24 or "|" in name or "\n" in name:
        raise ValueError("category must be 1–24 characters and not contain '|'")
    if name.lower() in RESERVED_CATEGORIES:
        raise ValueError(f"'{name}' is a reserved category name")
    return name

_HEX_COLOR_RE = re.compile(r"^#?[0-9a-fA-F]{6}$")

def clean_category_icon(icon):
    """A short emoji to represent a category; '' means 'use a default'. Capped well
    above a single emoji (family/flag sequences are several code units) but not free
    text. Display-only, so no other constraints beyond length / no newlines."""
    icon = (icon or "").strip()
    if "\n" in icon or len(icon) > 16:
        raise ValueError("icon must be a single emoji")
    return icon

def clean_category_color(color):
    """A 6-digit hex colour like '#1faa6c', normalised with a leading '#'. '' means
    'use a default'."""
    color = (color or "").strip()
    if not color:
        return ""
    if not _HEX_COLOR_RE.match(color):
        raise ValueError("color must be a 6-digit hex like #1faa6c")
    return color if color.startswith("#") else "#" + color

# --- TELEGRAM HANDLERS ---

# Conversation states for the add-expense flow
AWAITING_NAME, AWAITING_CATEGORY = range(2)

# Chats currently mid add-expense flow (chat_id -> epoch start time). The nightly
# clear skips these so it can't wipe an in-progress prompt or its inline keyboard
# and strand the user. The grace window means an abandoned flow stops blocking the
# clear after a while (state is in-memory, so a restart resets both anyway).
ACTIVE_FLOWS: dict[int, float] = {}
FLOW_GRACE_SECONDS = 900  # 15 min

def _flow_start(update):
    ACTIVE_FLOWS[update.effective_chat.id] = time.time()

def _flow_end(update):
    ACTIVE_FLOWS.pop(update.effective_chat.id, None)


def _gate(update) -> int | None:
    """Provision the user on first contact (open self-serve) and return their id,
    or None if they're banned. Use at the top of every user-facing handler."""
    u = update.effective_user
    if u is None:
        return None
    # Store/return the encrypted token, never the raw id. The token is the tenant key
    # everywhere; message-sending uses update.effective_chat.id (the real id) directly.
    tok = encode_id(u.id)
    return None if store.ensure_user(tok) else tok


def _is_admin(update) -> bool:
    return bool(update.effective_user and update.effective_user.id in ADMIN_USER_IDS)


async def spend(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Starts the add-expense flow by asking for a name. Triggered when the user
    sends a bare amount (e.g. "12.50") rather than an explicit command."""
    if _gate(update) is None:
        return ConversationHandler.END
    # The amount is the whole message (the regex entry filter guarantees it is
    # numeric, but re-validate the strict money form here in case spend is reached
    # another way). Rejects inf/nan, scientific notation (1e9), underscores (1_000)
    # and >2 decimals that float() would otherwise accept.
    raw = (update.message.text or "").strip()
    if not re.fullmatch(r'\d+(\.\d{1,2})?', raw):
        await update.message.reply_text("❌ Send an amount to log an expense.\nExample: 12.50")
        return ConversationHandler.END

    try:
        amount = clean_amount(float(raw))  # finite, > 0, within NUMERIC(12,2)
    except ValueError as e:
        await update.message.reply_text(f"⚠️ {str(e).capitalize()}.")
        return ConversationHandler.END
    # Stash the amount so the later steps can use it
    context.user_data['amount'] = amount
    _flow_start(update)  # protect this chat from the nightly clear until done
    await update.message.reply_text(
        f"💵 Amount: ${amount:.2f}\n📝 Please enter details:"
    )
    return AWAITING_NAME

async def receive_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Captures the expense name, then shows the category buttons."""
    name = update.message.text.strip()
    context.user_data['name'] = name
    amount = context.user_data['amount']

    # Build the button grid dynamically from this user's categories
    keyboard = []
    row = []
    for cat in store.get_categories(encode_id(update.effective_user.id)):
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
    """Captures the category button press and writes the expense to the store."""
    query = update.callback_query

    # Telegram requires you to answer the query to stop the loading animation on the button
    await query.answer()

    _, category = query.data.split("|")
    name = context.user_data.get('name', '')
    amount = context.user_data.get('amount', 0.0)

    # Save to Postgres for this user. Expenses added via the bot always count
    # toward the budget (no exclude option — that's webapp-only).
    store.add_transaction(encode_id(update.effective_user.id), "Expense", amount, name=name, category=category)

    # Replace the button grid with a success message
    await query.edit_message_text(f"✅ Logged: {name} — ${amount:.2f} for {category}")
    context.user_data.clear()
    _flow_end(update)
    return ConversationHandler.END

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Aborts the add-expense flow."""
    context.user_data.clear()
    _flow_end(update)
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
    """Renders a transaction dict as 'Name | Category | $Price'."""
    name = expense.get('name') or '(no name)'
    category = expense.get('category', '')
    try:
        amount = f"${float(expense['amount']):.2f}"
    except (ValueError, TypeError, KeyError):
        amount = f"${expense.get('amount', '')}"
    return f"{name} | {category} | {amount}"

# Intro / feature overview shown by /help (legacy Markdown). Edit freely; swap the
# name in. The webapp features are reached via the Mini App menu button.
HELP_TEXT = (
    "👋 *Welcome!* Expense tracking with zero friction.\n\n"
    "💵 *Log in seconds* — just send an amount like `12.50` and follow the prompts. "
    "No commands to remember.\n\n"
    "Open the app (Expenses button) for everything else:\n\n"
    "🔁 *Recurring expenses* — add a fixed monthly cost once; it's tracked for you every month.\n\n"
    "🎯 *Budgeting* — set a monthly budget and see what's left to spend at a glance.\n\n"
    "🚫 *Exclude from budget* — keep big one-off purchases out of your budget while still logging them.\n\n"
    "🏷️ *Categories & overview* — sort spending into your own categories and see it all in one "
    "consolidated dashboard.\n\n"
    "Send a number to get started 👇"
)


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if _gate(update) is None:
        return
    await update.message.reply_text(HELP_TEXT, parse_mode='Markdown')


async def undo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = _gate(update)
    if uid is None:
        return
    expense = store.delete_last(uid)
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
    uid = _gate(update)
    if uid is None:
        return
    expenses = store.month_expenses(uid, datetime.now().strftime("%Y-%m"))
    if not expenses:
        await update.message.reply_text("No expenses logged this month.")
        return

    lines = [f"**{datetime.now().strftime('%B %Y')} Expenses**"]
    total = 0.0
    for i, tx in enumerate(expenses, start=1):
        total += tx["amount"]
        # Escape user-controlled fields so stray markdown chars (e.g. "Mc_Donald")
        # can't break Telegram's Markdown parser and abort the message.
        name = escape_markdown(str(tx.get("name") or " "), version=1)
        date = escape_markdown(str(format_date(tx.get("date"))), version=1)
        amount = escape_markdown(f"{tx['amount']:.2f}", version=1)
        lines.append(f"`[{i}]` ({date}) {name}: ${amount}")

    lines.append(f"\n*Total: ${total:.2f}*")
    await _reply_chunked(update.message, "\n".join(lines), parse_mode='Markdown')

def _expense_id_by_index(uid: int, index: int):
    """Map a 1-based /list index to the underlying transaction id for this month."""
    expenses = store.month_expenses(uid, datetime.now().strftime("%Y-%m"))
    if 1 <= index <= len(expenses):
        return expenses[index - 1]["id"]
    return None

async def remove(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = _gate(update)
    if uid is None:
        return
    try:
        index = int(context.args[0])
    except (IndexError, ValueError):
        await update.message.reply_text("❌ Syntax: /rm [index]\nExample: /rm 3")
        return

    entry_id = _expense_id_by_index(uid, index)
    expense = store.delete_by_id(uid, entry_id) if entry_id else None
    if expense:
        await update.message.reply_text(
            f"🗑️ Deleted [{index}]: {format_expense(expense)}"
        )
    else:
        await update.message.reply_text(f"⚠️ No entry found at index [{index}].")

async def edit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = _gate(update)
    if uid is None:
        return
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

    entry_id = _expense_id_by_index(uid, entry_idx)
    expense = store.edit_transaction(uid, entry_id, category, price, name) if entry_id else None
    if not expense:
        await update.message.reply_text(f"⚠️ No entry found at index [{entry_idx}].")
        return

    await update.message.reply_text(
        f"✅ Updated [{entry_idx}]: {format_expense(expense)}"
    )

async def export_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Build the user's transactions into an .xlsx and send it into the chat."""
    uid = _gate(update)
    if uid is None:
        return
    txs = store.all_transactions(uid)
    if not txs:
        await update.message.reply_text("No transactions to export yet.")
        return

    wb = Workbook()
    ws = wb.active
    ws.title = "Transactions"
    ws.append(["ID", "Date", "Type", "Category", "Amount", "Name", "Recurring", "BudgetExcluded"])
    for t in txs:
        ws.append([
            t["id"], t["date"], t["type"], t["category"], t["amount"],
            t["name"], t["recurring"], t["budget_excluded"],
        ])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"expenses_{datetime.now():%Y%m%d}.xlsx"
    await update.message.reply_document(
        document=InputFile(buf, filename=filename), caption="📊 Your expense export"
    )

# --- ADMIN COMMANDS (restricted to ADMIN_USER_IDS) ---
async def ban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        return
    try:
        target = int(context.args[0])
    except (IndexError, ValueError):
        await update.message.reply_text("❌ Syntax: /ban [id from /stats]")
        return
    # `target` is the stored token shown by /stats (not the raw Telegram id).
    ok = store.set_banned(target, True)
    await update.message.reply_text(
        f"🚫 Banned user {target}." if ok else f"⚠️ No user {target} found."
    )

async def unban_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        return
    try:
        target = int(context.args[0])
    except (IndexError, ValueError):
        await update.message.reply_text("❌ Syntax: /unban [id from /stats]")
        return
    # `target` is the stored token shown by /stats (not the raw Telegram id).
    ok = store.set_banned(target, False)
    await update.message.reply_text(
        f"✅ Unbanned user {target}." if ok else f"⚠️ No user {target} found."
    )

async def stats_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        return
    s = store.stats()
    lines = [
        "**📊 Stats**",
        f"Users: {s['users']} ({s['banned']} banned)",
        f"Transactions: {s['transactions']}",
        "",
    ]
    for u in s["per_user"]:
        tag = " 🚫" if u["banned"] else ""
        # Show the stored token, never the real Telegram id. /ban takes this value.
        lines.append(f"`{u['user_id']}`{tag}: {u['tx_count']}")
    await _reply_chunked(update.message, "\n".join(lines), parse_mode='Markdown')

# --- TELEGRAM APPLICATION ---
def build_application():
    # In webhook mode we feed updates in ourselves, so PTB needs no Updater.
    builder = ApplicationBuilder().token(TELEGRAM_TOKEN)
    if WEBHOOK_URL:
        builder = builder.updater(None)
    application = builder.build()

    # Open self-serve: no user filter. Each handler provisions the user and checks
    # the ban flag itself (via _gate). The category callback step needs no gate —
    # the conversation is per-user, reachable only after spend's gate passed.

    # Register the multi-step add-expense flow: amount -> name -> category buttons.
    # A bare numeric message (e.g. "12.50") starts the flow — no command needed.
    amount_msg = filters.TEXT & ~filters.COMMAND & filters.Regex(r'^\d+(\.\d{1,2})?$')
    add_expense_conv = ConversationHandler(
        entry_points=[MessageHandler(amount_msg, spend)],
        states={
            AWAITING_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_name)],
            AWAITING_CATEGORY: [CallbackQueryHandler(receive_category, pattern=r"^setcat\|")],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    application.add_handler(add_expense_conv)

    # User commands
    application.add_handler(CommandHandler("help", help_cmd))
    application.add_handler(CommandHandler("undo", undo))
    application.add_handler(CommandHandler("list", list_month))
    application.add_handler(CommandHandler("rm", remove))
    application.add_handler(CommandHandler("edit", edit))
    application.add_handler(CommandHandler("export", export_cmd))

    # Admin commands
    application.add_handler(CommandHandler("ban", ban_cmd))
    application.add_handler(CommandHandler("unban", unban_cmd))
    application.add_handler(CommandHandler("stats", stats_cmd))

    application.add_error_handler(on_error)
    return application


async def on_error(update, context):
    """Last-resort handler: log the exception and tell the user instead of leaving
    them with silence (and a flow flag that would block the nightly clear)."""
    logging.error("Unhandled error processing update", exc_info=context.error)
    if not isinstance(update, Update):
        return
    if update.effective_chat is not None:
        ACTIVE_FLOWS.pop(update.effective_chat.id, None)
    try:
        if update.effective_message is not None:
            await update.effective_message.reply_text("⚠️ Something went wrong. Please try again.")
    except TelegramError:
        pass


application = build_application()

# --- WEB APP AUTH (Telegram Mini App initData validation) ---
# Locally (no WEBHOOK_URL) or with ALLOW_INSECURE_WEBAPP=1 we skip signature checks
# so the webapp can be previewed in a plain browser (no signed initData) — it then
# acts as DEV_USER_ID.
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


def _init_data_user_id(auth: dict):
    """Pull the numeric Telegram user id out of validated initData's `user` field."""
    try:
        return json.loads(auth.get("user", "")).get("id")
    except (ValueError, TypeError, AttributeError):
        return None


async def require_auth(x_telegram_init_data: str = Header(default="")) -> int:
    """Identify the Mini App user and return their numeric id. Open self-serve:
    a valid signature is all that's required (no allowlist); the user is provisioned
    on first call. 401 on a bad/missing signature, 403 if the user is banned."""
    if DEV_MODE:
        real_id = DEV_USER_ID
    else:
        auth = validate_init_data(x_telegram_init_data)
        if auth is None:
            raise HTTPException(status_code=401, detail="Unauthorized")
        real_id = _init_data_user_id(auth)
        if real_id is None:
            raise HTTPException(status_code=401, detail="Unauthorized")
    # The encrypted token is the tenant key used by every /api store call.
    user_id = encode_id(real_id)
    if store.ensure_user(user_id):  # returns True if banned
        raise HTTPException(status_code=403, detail="Banned")
    return user_id


# --- WEB API MODELS ---
VALID_TYPES = {"Expense", "Income", "Incoming"}


def _require_month(month: str) -> str:
    """Validate a 'YYYY-MM' month as a real calendar month, else HTTP 400. The
    explicit \\d{4}-\\d{2} check enforces zero-padding — strptime alone accepts
    '2026-6', which then mismatches the zero-padded months budget_summary groups
    on and silently reports zero spend."""
    if not isinstance(month, str) or not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(status_code=400, detail="month must be a valid YYYY-MM")
    try:
        datetime.strptime(month, "%Y-%m")
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="month must be a valid YYYY-MM")
    return month


def _require_date(date: str) -> str:
    """Validate a 'YYYY-MM-DD' date as a real calendar date, else HTTP 400. The
    explicit regex enforces zero-padding; strptime then rejects well-formed
    impossibilities like 2026-02-30 or 2026-13-99."""
    if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(status_code=400, detail="date must be a valid YYYY-MM-DD")
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
    budget_excluded: bool = False


# --- FASTAPI APP ---
@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_schema()  # create Postgres tables/indexes if needed
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
def api_list(month: str, user_id: int = Depends(require_auth)):
    _require_month(month)
    return {
        "transactions": store.get_month(user_id, month),
        "categories": store.get_categories_full(user_id),
    }


@app.post("/api/transactions")
def api_add(tx: TxIn, user_id: int = Depends(require_auth)):
    if tx.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(VALID_TYPES)}")
    try:
        amount = clean_amount(tx.amount)  # finite, > 0, within NUMERIC(12,2)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if tx.date is not None:
        _require_date(tx.date)
    created = store.add_transaction(
        user_id,
        tx.type,
        amount=amount,
        name=tx.name.strip(),
        category=tx.category.strip(),
        date=tx.date,
        recurring=tx.recurring,
        # Only expenses can be excluded from the budget; ignore the flag otherwise.
        budget_excluded=tx.budget_excluded and tx.type == "Expense",
    )
    return {"transaction": created}


@app.delete("/api/transactions/{entry_id}")
def api_delete(entry_id: str, month: str, user_id: int = Depends(require_auth)):
    _require_month(month)  # accepted for API compatibility; ids are unique per user
    deleted = store.delete_by_id(user_id, entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="No entry with that id")
    return {"deleted": deleted}


class TxEdit(BaseModel):
    category: str | None = None
    name: str | None = None
    amount: float | None = None
    budget_excluded: bool | None = None


@app.patch("/api/transactions/{entry_id}")
def api_edit(entry_id: str, tx: TxEdit, user_id: int = Depends(require_auth)):
    amount = None
    if tx.amount is not None:
        try:
            amount = clean_amount(tx.amount)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    category = tx.category.strip() if tx.category is not None else None
    name = tx.name.strip() if tx.name is not None else None
    updated = store.edit_transaction(
        user_id, entry_id, category=category, amount=amount, name=name,
        budget_excluded=tx.budget_excluded,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="No entry with that id")
    return {"transaction": updated}


@app.get("/api/recurring")
def api_recurring(user_id: int = Depends(require_auth)):
    return {"transactions": store.recurring_transactions(user_id)}


@app.get("/api/income")
def api_income(user_id: int = Depends(require_auth)):
    return {"transactions": store.income_transactions(user_id)}


@app.get("/api/categories")
def api_categories(user_id: int = Depends(require_auth)):
    return {"categories": store.get_categories_full(user_id)}


class CategoryIn(BaseModel):
    name: str
    icon: str | None = None
    color: str | None = None


@app.post("/api/categories")
def api_category_add(c: CategoryIn, user_id: int = Depends(require_auth)):
    try:
        name = clean_category(c.name)
        icon = clean_category_icon(c.icon)
        color = clean_category_color(c.color)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    store.add_category(user_id, name, icon=icon, color=color)
    return {"categories": store.get_categories_full(user_id)}


@app.delete("/api/categories/{name}")
def api_category_remove(name: str, user_id: int = Depends(require_auth)):
    store.remove_category(user_id, name)
    return {"categories": store.get_categories_full(user_id)}


class BudgetIn(BaseModel):
    amount: float


def _require_positive_budget(amount: float) -> float:
    # Budget must be finite, > 0 and within NUMERIC(12,2) — same rules as an amount.
    try:
        return clean_amount(amount, label="budget")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/budget")
def api_budget_get(month: str, user_id: int = Depends(require_auth)):
    _require_month(month)
    return store.budget_summary(user_id, month)


@app.post("/api/budget")
def api_budget_set(b: BudgetIn, month: str, user_id: int = Depends(require_auth)):
    _require_month(month)
    store.set_budget(user_id, _require_positive_budget(b.amount))
    return store.budget_summary(user_id, month)


@app.delete("/api/budget")
def api_budget_remove(month: str, user_id: int = Depends(require_auth)):
    _require_month(month)
    store.remove_budget(user_id)
    return store.budget_summary(user_id, month)


@app.get("/api/home")
def api_home(month: str, user_id: int = Depends(require_auth)):
    """Everything the Home screen needs in one round-trip — month transactions,
    the recurring list, categories and the budget summary — so opening the app is a
    single request instead of four separate /api calls."""
    _require_month(month)
    return {
        "transactions": store.get_month(user_id, month),
        "recurring": store.recurring_transactions(user_id),
        "categories": store.get_categories_full(user_id),
        "budget": store.budget_summary(user_id, month),
    }


# --- DAILY MESSAGE CLEAR ---
# Triggered by an external cron (e.g. cron-job.org / GitHub Actions) at 00:00
# SGT, since Render's free tier sleeps and an in-app scheduler would be skipped.
# Telegram has no "clear chat" call: we delete message_ids one at a time, and
# only messages < 48h old can be deleted — a daily sweep stays inside that window.
CLEAR_TASK_TOKEN = os.getenv("CLEAR_TASK_TOKEN")
# How far back to sweep the very first time for a chat (we have no bookmark yet).
# Messages older than Telegram's 48h limit simply error out and are skipped.
FIRST_RUN_LOOKBACK = 500


async def clear_chat_messages(user_token: int) -> int:
    """Delete recent messages in a private chat. Sends a silent probe to learn the
    newest message_id, posts a permanent "cleared" message (so the chat is never left
    empty — Telegram auto-unpins chats with 0 messages), then deletes from the
    last-cleared bookmark up to the probe. The keeper survives this run and is removed
    by the next one.

    Takes the user's stored token; the real chat_id (needed to message Telegram) is
    decoded from it. The clear bookmark stays keyed by the token (FK to users).

    Returns the number deleted, or -1 if skipped because the user is mid add-expense
    flow (so we don't wipe a live prompt / inline keyboard and strand them)."""
    chat_id = decode_id(user_token)   # real Telegram chat id for sends/deletes
    started = ACTIVE_FLOWS.get(chat_id)
    if started is not None and (time.time() - started) < FLOW_GRACE_SECONDS:
        logging.info("clear: skipping chat %s — add-expense flow in progress", chat_id)
        return -1

    bot = application.bot
    try:
        probe = await bot.send_message(
            chat_id, "🧹 Clearing today's messages…", disable_notification=True
        )
    except TelegramError as e:
        logging.warning("clear: cannot reach chat %s: %s", chat_id, e)
        return 0

    newest = probe.message_id
    # Post a permanent "cleared" message *before* deleting, so the chat is never left
    # with 0 messages (Telegram auto-unpins empty chats). Its message_id is higher
    # than the probe's `newest`, so it falls outside the delete range below and
    # survives; the next run deletes it (start = newest + 1) and posts a fresh one.
    # If it can't be sent, skip deleting so we never risk emptying the chat.
    try:
        await bot.send_message(chat_id, "✅ Chat cleared!", disable_notification=True)
    except TelegramError as e:
        logging.warning("clear: could not post keeper for chat %s, skipping: %s", chat_id, e)
        return 0

    # The clear bookmark is keyed by the user's stored token (FK to users), not the
    # raw chat_id.
    cleared_up_to = store.get_cleared_up_to(user_token)
    start = (cleared_up_to + 1) if cleared_up_to else max(1, newest - FIRST_RUN_LOOKBACK)

    deleted = 0
    for mid in range(start, newest + 1):
        try:
            if await bot.delete_message(chat_id, mid):
                deleted += 1
        except RetryAfter as e:
            await asyncio.sleep(e.retry_after + 1)
            try:
                await bot.delete_message(chat_id, mid)
                deleted += 1
            except TelegramError:
                pass
        except TelegramError:
            pass  # too old (>48h), already gone, or undeletable — skip it
    store.set_cleared_up_to(user_token, newest)
    return deleted


_BACKGROUND_TASKS: set[asyncio.Task] = set()


async def _run_clear_sweep():
    # Sweep every (non-banned) registered user — in private chats chat_id == user_id.
    # Deleting messages is one-at-a-time and rate-limited, so a first run (or a long
    # gap) can take minutes — far longer than a cron's HTTP timeout. We run it as a
    # background task so the endpoint can ack immediately; results go to the log.
    cleared = {str(uid): await clear_chat_messages(uid) for uid in store.all_user_ids()}
    logging.info("clear sweep done: %s", cleared)


@app.post("/tasks/clear", status_code=202)
async def api_clear(x_task_token: str = Header(default="")):
    # Guarded by a shared secret so only the cron job can trigger it. If the token
    # env var is unset the endpoint is disabled (always 403) rather than open.
    if not CLEAR_TASK_TOKEN or not hmac.compare_digest(x_task_token, CLEAR_TASK_TOKEN):
        raise HTTPException(status_code=403, detail="Forbidden")
    # Fire-and-forget: kick off the sweep and return at once so the cron sees a fast
    # 202 instead of timing out while we churn through deletes. Keep a reference in a
    # module-level set so the task isn't garbage-collected mid-run (a known asyncio
    # gotcha), discarding it once done.
    task = asyncio.create_task(_run_clear_sweep())
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return {"status": "accepted"}


# --- MONTHLY RECURRING MATERIALIZATION ---
# Triggered by an external cron (daily is fine — it's a no-op until a new month starts).
# Turns each user's recurring templates (recurring expenses + income) into a concrete,
# plain transaction dated the 1st of the month. See Store.materialize_recurring.
RECURRING_TASK_TOKEN = os.getenv("RECURRING_TASK_TOKEN")


@app.post("/tasks/recurring")
def api_recurring_run(x_task_token: str = Header(default="")):
    # Guarded by a shared secret; disabled (always 403) if the token env var is unset.
    if not RECURRING_TASK_TOKEN or not hmac.compare_digest(x_task_token, RECURRING_TASK_TOKEN):
        raise HTTPException(status_code=403, detail="Forbidden")
    # DB-only and fast, so run synchronously. Same local-time convention as the rest of
    # the app (add_transaction / set_budget both use datetime.now()).
    current = datetime.now().strftime("%Y-%m")
    result = {uid: store.materialize_recurring(uid, current) for uid in store.all_user_ids()}
    logging.info("recurring materialize: %s", result)
    return {"status": "ok", "created": sum(result.values())}


@app.get("/health")
def health():
    """Keep-alive target for an external cron (every ~10 min) so Render's free
    instance never spins down. The SELECT 1 also keeps the scale-to-zero DB warm,
    killing both cold starts in one ping. Public + cheap; exposes nothing.

    If the DB is still mid-wake, ping() returns False rather than raising: we
    report 503 (DB warming) instead of a noisy 500 traceback. The attempt itself
    kicks off Neon's wake, so the next ping lands warm."""
    if store.ping():
        return {"ok": True}
    return JSONResponse(status_code=503, content={"ok": False, "db": "warming"})


# Serve the Mini App's static files. Mounted last so it doesn't shadow the
# API/webhook routes above. html=True makes "/" serve index.html.
_WEBAPP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webapp")


class _WebappStatic(StaticFiles):
    """StaticFiles that tells clients never to cache index.html. The HTML is the
    entry point that references app.js?v=N / style.css?v=N, so it must always be
    re-fetched — otherwise a client keeps an old index.html (with old ?v= refs) and
    never sees a deploy. The versioned JS/CSS themselves stay cacheable."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path in ("", ".", "/") or path.endswith(".html"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response


app.mount("/", _WebappStatic(directory=_WEBAPP_DIR, html=True), name="webapp")


if __name__ == "__main__":
    import uvicorn

    mode = "webhook" if WEBHOOK_URL else "polling (local)"
    print(f"Starting server on port {PORT} — Telegram mode: {mode}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
