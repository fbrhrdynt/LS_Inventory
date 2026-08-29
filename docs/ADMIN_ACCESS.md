# LS Inventory Web Admin — Roles and Inventory Delete

This update is cumulative with the Device Pairing update.

## Inventory Delete

The Inventory table now has:

```text
QR | Edit | Delete
```

Deleting an item is a soft delete:

- the item disappears from active Inventory;
- Central records an `ITEMS / DELETE` sync change;
- cabinets receive the deletion on their next Central sync;
- existing transaction history is retained.

A `BORROWED` item cannot be deleted. Return it first, then delete it.

## Web Admin accounts

A new **Admin Users** menu is available to Administrators.

Available roles:

### Administrator

Full Web Admin access:

```text
Dashboard
Inventory
Users
Transactions
Devices & Maintenance
Admin Users
Settings
```

### Admin Staff

Limited Web Admin access:

```text
Dashboard
Inventory
Users
Transactions
```

Admin Staff cannot access:

```text
Devices & Maintenance
Admin Users
Settings
```

Restrictions are enforced both in the Web UI and Central API.

## Add a new Web Admin account

Open:

```text
Web Admin -> Admin Users -> + Add Admin User
```

Fields:

```text
Display Name
Username
Role
Status
Password
Confirm Password
```

Password minimum: 8 characters.

## Edit an account

Administrators can change:

```text
Display Name
Username
Role
Status
Password (optional)
```

Leave the password fields blank to keep the existing password.

## Delete an account

Delete disables the Web Admin account and revokes its active sessions.

Safety rules:

- the currently signed-in Administrator cannot delete itself;
- the currently signed-in Administrator cannot disable or demote itself;
- at least one active Administrator must always remain.

## Existing admin account

Older LS Inventory installations may store the original account role as:

```text
SUPERADMIN
```

The Web Admin treats this as:

```text
Administrator
```

No manual database migration is required.
