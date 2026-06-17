"""Postgres system of record for the multi-user expense bot.

`Store` mirrors the web-facing methods of `SheetsHelper` (main.py) but every row is
scoped by the Telegram numeric `user_id`, so users are isolated from each other.
Open self-serve: `ensure_user` upserts a row on first contact — there is no
allowlist. The pool/schema are created lazily so this module imports fine even
before DATABASE_URL is configured (useful mid-migration).
"""

import os
import uuid
from datetime import datetime, date as date_cls

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# Seeded for each user the first time their categories are read. After that the
# list is fully user-editable (add/remove) and stored per user.
DEFAULT_CATEGORIES = ["Food", "Transport", "Shopping", "Groceries", "Bills", "Others"]

# Neon/Supabase connection strings already carry `sslmode=require`.
_pool: ConnectionPool | None = None


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        # Read at first use, not import time — main.py imports this module before
        # it calls load_dotenv(), so the env var isn't set yet during import.
        dsn = os.getenv("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL is not set")
        # check_connection validates (and transparently recycles) each connection
        # on checkout. Neon scales to zero and terminates idle connections server-
        # side ("terminating connection due to administrator command"); without a
        # check the pool would hand out a dead socket and the first query after an
        # idle gap would 500. The check makes that first call reconnect instead.
        # prepare_threshold=None disables psycopg3's automatic server-side prepared
        # statements. Neon's pooled endpoint (the `-pooler` host) is PgBouncer in
        # transaction-pooling mode, where prepared statements span connections and
        # break ("prepared statement already exists"). Harmless on a direct endpoint.
        _pool = ConnectionPool(
            dsn,
            min_size=1,
            max_size=5,
            check=ConnectionPool.check_connection,
            kwargs={"row_factory": dict_row, "prepare_threshold": None},
        )
    return _pool


# DDL is split into single statements (psycopg's extended protocol runs one per call).
SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS users (
        user_id    BIGINT PRIMARY KEY,
        username   TEXT,                       -- retained but unused: no longer written (privacy)
        banned     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    # Usernames are no longer collected (privacy); wipe any captured before this.
    # Idempotent: matches nothing once they're all NULL.
    "UPDATE users SET username = NULL WHERE username IS NOT NULL",
    """
    CREATE TABLE IF NOT EXISTS transactions (
        id              TEXT PRIMARY KEY,
        seq             BIGSERIAL,                 -- insertion order (for /undo and stable bot indices)
        user_id         BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
        date            DATE NOT NULL,
        type            TEXT NOT NULL,
        category        TEXT NOT NULL DEFAULT '',
        amount          NUMERIC(12, 2) NOT NULL,
        name            TEXT NOT NULL DEFAULT '',
        recurring       BOOLEAN NOT NULL DEFAULT FALSE,
        budget_excluded BOOLEAN NOT NULL DEFAULT FALSE
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_tx_user_date ON transactions(user_id, date)",
    """
    CREATE TABLE IF NOT EXISTS budgets (
        user_id         BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
        effective_month CHAR(7) NOT NULL,           -- 'YYYY-MM'
        amount          NUMERIC(12, 2) NOT NULL,    -- 0 = "removed from here onward"
        PRIMARY KEY (user_id, effective_month)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS clear_state (
        user_id       BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
        cleared_up_to BIGINT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS categories (
        user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
        name    TEXT NOT NULL,
        seq     BIGSERIAL,
        icon    TEXT NOT NULL DEFAULT '',   -- user-chosen emoji ('' = fall back to a default)
        color   TEXT NOT NULL DEFAULT '',   -- user-chosen hex   ('' = fall back to a default)
        PRIMARY KEY (user_id, name)
    )
    """,
    # Migrate tables created before icon/color existed.
    "ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE categories ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT ''",
]


def init_schema():
    """Create tables/indexes if they don't exist. Call once at startup."""
    with _get_pool().connection() as conn:
        for stmt in SCHEMA:
            conn.execute(stmt)


# --- helpers -----------------------------------------------------------
def _month_bounds(ym: str):
    """'2026-06' -> (date(2026,6,1), date(2026,7,1)) for a half-open range."""
    start = datetime.strptime(ym, "%Y-%m").date()
    end = date_cls(start.year + 1, 1, 1) if start.month == 12 else date_cls(start.year, start.month + 1, 1)
    return start, end


def _tx(row) -> dict:
    """Map a DB row to the JSON shape the webapp expects (same as SheetsHelper)."""
    return {
        "id": row["id"],
        "date": row["date"].isoformat(),
        "type": row["type"],
        "category": row["category"] or "",
        "amount": float(row["amount"]),
        "name": row["name"] or "",
        "recurring": bool(row["recurring"]),
        "budget_excluded": bool(row["budget_excluded"]),
    }


class Store:
    """Per-user data access. Every method takes the Telegram user_id as the tenant key."""

    # --- users -------------------------------------------------------
    def ensure_user(self, user_id: int) -> bool:
        """Provision a user on first contact (open self-serve). Idempotent.
        Returns True if the user is banned. Usernames are intentionally NOT stored
        (privacy) — only the numeric user_id is used anywhere in the app. The no-op
        DO UPDATE makes the existing row's `banned` come back via RETURNING."""
        with _get_pool().connection() as conn:
            row = conn.execute(
                """
                INSERT INTO users (user_id) VALUES (%s)
                ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
                RETURNING banned
                """,
                (user_id,),
            ).fetchone()
        return bool(row["banned"])

    def is_banned(self, user_id: int) -> bool:
        with _get_pool().connection() as conn:
            row = conn.execute(
                "SELECT banned FROM users WHERE user_id = %s", (user_id,)
            ).fetchone()
        return bool(row and row["banned"])

    def set_banned(self, user_id: int, banned: bool) -> bool:
        """Ban/unban a user. Returns True if a matching user row existed."""
        with _get_pool().connection() as conn:
            row = conn.execute(
                "UPDATE users SET banned = %s WHERE user_id = %s RETURNING user_id",
                (banned, user_id),
            ).fetchone()
        return row is not None

    def all_user_ids(self, include_banned: bool = False) -> list[int]:
        """Every registered user id (used by the nightly clear)."""
        sql = "SELECT user_id FROM users"
        if not include_banned:
            sql += " WHERE NOT banned"
        with _get_pool().connection() as conn:
            rows = conn.execute(sql).fetchall()
        return [r["user_id"] for r in rows]

    def stats(self) -> dict:
        """Admin overview: totals + per-user transaction counts."""
        with _get_pool().connection() as conn:
            totals = conn.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM users) AS users,
                    (SELECT COUNT(*) FROM users WHERE banned) AS banned,
                    (SELECT COUNT(*) FROM transactions) AS transactions
                """
            ).fetchone()
            per_user = conn.execute(
                """
                SELECT u.user_id, u.username, u.banned, COUNT(t.id) AS tx_count
                FROM users u LEFT JOIN transactions t ON t.user_id = u.user_id
                GROUP BY u.user_id, u.username, u.banned
                ORDER BY tx_count DESC
                """
            ).fetchall()
        return {
            "users": totals["users"],
            "banned": totals["banned"],
            "transactions": totals["transactions"],
            "per_user": [
                {"user_id": r["user_id"], "username": r["username"],
                 "banned": bool(r["banned"]), "tx_count": r["tx_count"]}
                for r in per_user
            ],
        }

    # --- transactions ------------------------------------------------
    def get_month(self, user_id: int, ym: str) -> list[dict]:
        """All of a user's transactions for 'YYYY-MM', newest first."""
        start, end = _month_bounds(ym)
        with _get_pool().connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM transactions
                WHERE user_id = %s AND date >= %s AND date < %s
                ORDER BY date DESC, id
                """,
                (user_id, start, end),
            ).fetchall()
        return [_tx(r) for r in rows]

    def add_transaction(self, user_id: int, tx_type, amount, name="", category="",
                        date=None, recurring=False, budget_excluded=False) -> dict:
        date_str = date or datetime.now().strftime("%Y-%m-%d")
        entry_id = str(uuid.uuid4())[:8]
        with _get_pool().connection() as conn:
            row = conn.execute(
                """
                INSERT INTO transactions
                    (id, user_id, date, type, category, amount, name, recurring, budget_excluded)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (entry_id, user_id, date_str, tx_type, category, amount, name,
                 recurring, budget_excluded),
            ).fetchone()
        return _tx(row)

    def delete_by_id(self, user_id: int, entry_id: str) -> dict | None:
        """Delete one of the user's transactions by id. Returns it, or None."""
        with _get_pool().connection() as conn:
            row = conn.execute(
                "DELETE FROM transactions WHERE user_id = %s AND id = %s RETURNING *",
                (user_id, entry_id),
            ).fetchone()
        return _tx(row) if row else None

    def delete_last(self, user_id: int) -> dict | None:
        """Delete the user's most recently added transaction (for the bot's /undo)."""
        with _get_pool().connection() as conn:
            row = conn.execute(
                """
                DELETE FROM transactions
                WHERE seq = (SELECT MAX(seq) FROM transactions WHERE user_id = %s)
                RETURNING *
                """,
                (user_id,),
            ).fetchone()
        return _tx(row) if row else None

    def month_expenses(self, user_id: int, ym: str) -> list[dict]:
        """A user's Expense rows for 'YYYY-MM' in insertion order — gives the bot's
        /list a stable 1-based index that /rm and /edit can address."""
        start, end = _month_bounds(ym)
        with _get_pool().connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM transactions
                WHERE user_id = %s AND type = 'Expense' AND date >= %s AND date < %s
                ORDER BY seq
                """,
                (user_id, start, end),
            ).fetchall()
        return [_tx(r) for r in rows]

    def edit_transaction(self, user_id: int, entry_id: str, category=None,
                         amount=None, name=None, budget_excluded=None) -> dict | None:
        """Update the given fields of one transaction. Returns the updated row, or None."""
        sets, params = [], []
        if category is not None:
            sets.append("category = %s"); params.append(category)
        if amount is not None:
            sets.append("amount = %s"); params.append(amount)
        if name is not None:
            sets.append("name = %s"); params.append(name)
        if budget_excluded is not None:
            sets.append("budget_excluded = %s"); params.append(budget_excluded)
        with _get_pool().connection() as conn:
            if not sets:  # nothing to change — just return the current row
                row = conn.execute(
                    "SELECT * FROM transactions WHERE user_id = %s AND id = %s",
                    (user_id, entry_id),
                ).fetchone()
            else:
                params += [user_id, entry_id]
                row = conn.execute(
                    f"UPDATE transactions SET {', '.join(sets)} "
                    "WHERE user_id = %s AND id = %s RETURNING *",
                    params,
                ).fetchone()
        return _tx(row) if row else None

    def recurring_transactions(self, user_id: int) -> list[dict]:
        """A user's recurring EXPENSES, newest first — for the webapp's Recurring
        section (manage/edit/delete active recurring items). Recurring income is
        excluded; it's managed from its own flow."""
        with _get_pool().connection() as conn:
            rows = conn.execute(
                "SELECT * FROM transactions WHERE user_id = %s AND recurring "
                "AND type = 'Expense' ORDER BY seq DESC",
                (user_id,),
            ).fetchall()
        return [_tx(r) for r in rows]

    def income_transactions(self, user_id: int) -> list[dict]:
        """A user's income entries, newest first — for the webapp's Income section
        (manage/edit/delete). Income is recurring monthly."""
        with _get_pool().connection() as conn:
            rows = conn.execute(
                "SELECT * FROM transactions WHERE user_id = %s AND type = 'Income' "
                "ORDER BY seq DESC",
                (user_id,),
            ).fetchall()
        return [_tx(r) for r in rows]

    # --- categories (per user, editable) ----------------------------
    def _ensure_categories(self, conn, user_id: int):
        """Return (name, icon, color) rows in order, lazily seeding DEFAULT_CATEGORIES
        the first time (user row must already exist — callers ensure_user first)."""
        sql = "SELECT name, icon, color FROM categories WHERE user_id = %s ORDER BY seq"
        rows = conn.execute(sql, (user_id,)).fetchall()
        if not rows:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO categories (user_id, name) VALUES (%s, %s) "
                    "ON CONFLICT DO NOTHING",
                    [(user_id, c) for c in DEFAULT_CATEGORIES],
                )
            rows = conn.execute(sql, (user_id,)).fetchall()
        return rows

    def get_categories(self, user_id: int) -> list[str]:
        """The user's category names in order (used by the bot's button grid)."""
        with _get_pool().connection() as conn:
            return [r["name"] for r in self._ensure_categories(conn, user_id)]

    def get_categories_full(self, user_id: int) -> list[dict]:
        """The user's categories as {name, icon, color} in order (for the webapp).
        icon/color are '' when unset — the client falls back to its own defaults."""
        with _get_pool().connection() as conn:
            return [
                {"name": r["name"], "icon": r["icon"] or "", "color": r["color"] or ""}
                for r in self._ensure_categories(conn, user_id)
            ]

    def add_category(self, user_id: int, name: str, icon: str = "", color: str = "") -> bool:
        """Add a category with an optional emoji icon and hex colour. Returns False
        if it already existed."""
        with _get_pool().connection() as conn:
            row = conn.execute(
                "INSERT INTO categories (user_id, name, icon, color) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT DO NOTHING RETURNING name",
                (user_id, name, icon, color),
            ).fetchone()
        return row is not None

    def remove_category(self, user_id: int, name: str) -> bool:
        """Remove a category (existing transactions keep their category text).
        Returns False if it wasn't there."""
        with _get_pool().connection() as conn:
            row = conn.execute(
                "DELETE FROM categories WHERE user_id = %s AND name = %s RETURNING name",
                (user_id, name),
            ).fetchone()
        return row is not None

    def all_transactions(self, user_id: int, since: str | None = None) -> list[dict]:
        """Every transaction for a user (optionally on/after a 'YYYY-MM-DD' date),
        oldest first — for the spreadsheet export."""
        sql = "SELECT * FROM transactions WHERE user_id = %s"
        params: list = [user_id]
        if since:
            sql += " AND date >= %s"
            params.append(since)
        sql += " ORDER BY date, id"
        with _get_pool().connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_tx(r) for r in rows]

    # --- budgets (effective-dated ledger, per user) ------------------
    def _budget_ledger(self, user_id: int):
        """Sorted [(effective_month, amount float)] (0 = removed)."""
        with _get_pool().connection() as conn:
            rows = conn.execute(
                "SELECT effective_month, amount FROM budgets WHERE user_id = %s ORDER BY effective_month",
                (user_id,),
            ).fetchall()
        return [(r["effective_month"], float(r["amount"])) for r in rows]

    @staticmethod
    def _budget_for_month(ym: str, ledger):
        effective = None
        for month, amount in ledger:  # ascending
            if month <= ym:
                effective = amount
            else:
                break
        return effective if (effective and effective > 0) else None

    def budget_for_month(self, user_id: int, ym: str):
        return self._budget_for_month(ym, self._budget_ledger(user_id))

    def _upsert_budget(self, user_id: int, ym: str, amount):
        with _get_pool().connection() as conn:
            conn.execute(
                """
                INSERT INTO budgets (user_id, effective_month, amount) VALUES (%s, %s, %s)
                ON CONFLICT (user_id, effective_month) DO UPDATE SET amount = EXCLUDED.amount
                """,
                (user_id, ym, amount),
            )

    def set_budget(self, user_id: int, amount: float):
        """Set/change the budget from the current month onward (validated by caller)."""
        self._upsert_budget(user_id, datetime.now().strftime("%Y-%m"), float(amount))
        return float(amount)

    def remove_budget(self, user_id: int):
        """Remove the budget from the current month onward (past months keep theirs)."""
        self._upsert_budget(user_id, datetime.now().strftime("%Y-%m"), 0)

    def budget_summary(self, user_id: int, current_ym: str) -> dict:
        """Same shape as SheetsHelper.budget_summary, computed from per-month aggregates.
        `spent_this_month`/`overall_surplus` exclude budget-excluded expenses; totals and
        savings count everything."""
        with _get_pool().connection() as conn:
            rows = conn.execute(
                """
                SELECT to_char(date, 'YYYY-MM') AS ym,
                       COALESCE(SUM(amount) FILTER (WHERE type = 'Expense'), 0) AS total_expense,
                       COALESCE(SUM(amount) FILTER (WHERE type = 'Expense' AND NOT budget_excluded), 0) AS budgeted,
                       COALESCE(SUM(amount) FILTER (WHERE type IN ('Income', 'Incoming')), 0) AS total_in
                FROM transactions WHERE user_id = %s
                GROUP BY ym
                """,
                (user_id,),
            ).fetchall()
        ledger = self._budget_ledger(user_id)

        overall_surplus = 0.0
        has_budget_any = False
        total_in = total_expense = spent_this_month = 0.0
        for r in rows:
            ym = r["ym"]
            budgeted = float(r["budgeted"])
            total_expense += float(r["total_expense"])
            total_in += float(r["total_in"])
            if ym == current_ym:
                spent_this_month = budgeted
            budget = self._budget_for_month(ym, ledger)
            if budget is not None:
                has_budget_any = True
                overall_surplus += budget - budgeted

        budget = self._budget_for_month(current_ym, ledger)
        left = (budget - spent_this_month) if budget is not None else None
        return {
            "budget": round(budget, 2) if budget is not None else None,
            "spent_this_month": round(spent_this_month, 2),
            "left": round(left, 2) if left is not None else None,
            "overall_surplus": round(overall_surplus, 2) if has_budget_any else None,
            "total_savings": round(total_in - total_expense, 2),
        }

    # --- daily clear bookmark ---------------------------------------
    def get_cleared_up_to(self, user_id: int):
        with _get_pool().connection() as conn:
            row = conn.execute(
                "SELECT cleared_up_to FROM clear_state WHERE user_id = %s", (user_id,)
            ).fetchone()
        return row["cleared_up_to"] if row else None

    def ping(self):
        """Trivial query used by /health to keep the (scale-to-zero) DB warm."""
        with _get_pool().connection() as conn:
            conn.execute("SELECT 1")

    def set_cleared_up_to(self, user_id: int, message_id: int):
        with _get_pool().connection() as conn:
            conn.execute(
                """
                INSERT INTO clear_state (user_id, cleared_up_to) VALUES (%s, %s)
                ON CONFLICT (user_id) DO UPDATE SET cleared_up_to = EXCLUDED.cleared_up_to
                """,
                (user_id, message_id),
            )
