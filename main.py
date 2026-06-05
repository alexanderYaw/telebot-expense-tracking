import os
import re
import uuid
import logging
from datetime import datetime
import gspread
from google.oauth2.service_account import Credentials
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    ConversationHandler, MessageHandler, filters, ContextTypes,
)
from dotenv import load_dotenv

# Load environment variables from the .env file
load_dotenv()

# --- CONFIGURATION ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
SPREADSHEET_URL_OR_ID = os.getenv("SPREADSHEET_ID")
GOOGLE_CREDENTIALS_FILE = "service_account.json"

if not TELEGRAM_TOKEN:
    raise ValueError("No TELEGRAM_TOKEN found in .env file.")

# Define your custom categories here
CATEGORIES = ["Food", "Transport", "Shopping", "Groceries", "Bills", "Climbing", "Others"]

# Enable logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GOOGLE SHEETS HELPER ---
class SheetsHelper:
    def __init__(self):
        scopes = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
        creds = Credentials.from_service_account_file(GOOGLE_CREDENTIALS_FILE, scopes=scopes)
        self.client = gspread.authorize(creds)
        self.sheet = self.client.open_by_key(SPREADSHEET_URL_OR_ID)

    def _get_current_month_worksheet(self):
        month_name = datetime.now().strftime("%b_%Y")
        try:
            return self.sheet.worksheet(month_name)
        except gspread.exceptions.WorksheetNotFound:
            ws = self.sheet.add_worksheet(title=month_name, rows="100", cols="6")
            ws.append_row(["ID", "Date", "Type", "Category", "Amount", "Notes"])
            return ws

    def add_expense(self, category: str, amount: float, name: str = ""):
        ws = self._get_current_month_worksheet()
        entry_id = str(uuid.uuid4())[:8]
        date_str = datetime.now().strftime("%Y-%m-%d")
        ws.append_row([entry_id, date_str, "Expense", category, amount, name])
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

        if category:
            ws.update_cell(target_row, 4, category)
        if amount:
            ws.update_cell(target_row, 5, amount)
        if name is not None:
            ws.update_cell(target_row, 6, name)

        # Read the row back so the caller gets the full, up-to-date expense
        return self._row_to_expense(ws.row_values(target_row))

db = SheetsHelper()

# --- TELEGRAM HANDLERS ---

# Conversation states for the add-expense flow
AWAITING_NAME, AWAITING_CATEGORY = range(2)

async def spend(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /spend [amount] — starts the add-expense flow by asking for a name."""
    try:
        amount = float(context.args[0])
    except (IndexError, ValueError):
        await update.message.reply_text("❌ Syntax: /spend [amount]\nExample: /spend 12.50")
        return ConversationHandler.END

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

async def list_month(update: Update, context: ContextTypes.DEFAULT_TYPE):
    records = db.list_expenses()
    if not records:
        await update.message.reply_text("No expenses logged this month.")
        return

    response = f"**{datetime.now().strftime('%B %Y')} Expenses**\n"
    total = 0.0
    
    for i, row in enumerate(records, start=1):
        if row['Type'] == 'Expense':
            name = row.get('Notes') or ' '
            response += f"`[{i}]` ({format_date(row['Date'])}) {name}: ${row['Amount']}\n"
            total += float(row['Amount'])
            
    response += f"\n*Total: ${total:.2f}*"
    await update.message.reply_text(response, parse_mode='Markdown')

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

# --- MAIN EXECUTION ---
if __name__ == '__main__':
    app = ApplicationBuilder().token(TELEGRAM_TOKEN).build()

    # Register the multi-step add-expense flow: /spend -> name -> category buttons
    add_expense_conv = ConversationHandler(
        entry_points=[CommandHandler("spend", spend)],
        states={
            AWAITING_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_name)],
            AWAITING_CATEGORY: [CallbackQueryHandler(receive_category, pattern=r"^setcat\|")],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    app.add_handler(add_expense_conv)

    # Register Text Commands
    app.add_handler(CommandHandler("undo", undo))
    app.add_handler(CommandHandler("list", list_month))
    app.add_handler(CommandHandler("rm", remove))
    app.add_handler(CommandHandler("edit", edit))

    print("Bot is polling...")
    app.run_polling()