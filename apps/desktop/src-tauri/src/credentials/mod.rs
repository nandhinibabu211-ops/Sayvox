//! Auth token storage in Windows Credential Manager (Story 2.2 AC 2, ADR-010).
//!
//! Only the slots in [`Slot`] can be read or written from the web UI, so a compromised
//! page can't use these commands to read arbitrary Windows credentials.

use serde::{Deserialize, Serialize};

/// Credential Manager "service" (target) prefix for every Sayvox entry.
pub const SERVICE: &str = "app.sayvox.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Slot {
    /// JSON: `{ idToken, refreshToken, expiresAt, email }`.
    AuthSession,
}

impl Slot {
    pub fn account(self) -> &'static str {
        match self {
            Slot::AuthSession => "auth-session",
        }
    }
}

/// Upper bound for one stored value (tokens are ~1–2 KB; Credential Manager caps blobs at 2.5 KB).
pub const MAX_VALUE_BYTES: usize = 2_400;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum CredentialError {
    #[error("value too large")]
    TooLarge,
    #[error("credential store unavailable: {0}")]
    Store(String),
}

/// Storage backend, abstracted so the slot/size rules are unit-testable without Windows.
pub trait CredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, CredentialError>;
    fn set(&self, account: &str, value: &str) -> Result<(), CredentialError>;
    fn delete(&self, account: &str) -> Result<(), CredentialError>;
}

/// Windows Credential Manager via the `keyring` crate.
pub struct WindowsCredentialStore;

impl WindowsCredentialStore {
    fn entry(account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE, account).map_err(|e| CredentialError::Store(e.to_string()))
    }
}

impl CredentialStore for WindowsCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, CredentialError> {
        match Self::entry(account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CredentialError::Store(e.to_string())),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), CredentialError> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|e| CredentialError::Store(e.to_string()))
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CredentialError::Store(e.to_string())),
        }
    }
}

pub fn read(store: &dyn CredentialStore, slot: Slot) -> Result<Option<String>, CredentialError> {
    store.get(slot.account())
}

pub fn write(store: &dyn CredentialStore, slot: Slot, value: &str) -> Result<(), CredentialError> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(CredentialError::TooLarge);
    }
    store.set(slot.account(), value)
}

pub fn clear(store: &dyn CredentialStore, slot: Slot) -> Result<(), CredentialError> {
    store.delete(slot.account())
}

#[tauri::command]
pub fn credentials_get(slot: Slot) -> Result<Option<String>, CredentialError> {
    read(&WindowsCredentialStore, slot)
}

#[tauri::command]
pub fn credentials_set(slot: Slot, value: String) -> Result<(), CredentialError> {
    write(&WindowsCredentialStore, slot, &value)
}

#[tauri::command]
pub fn credentials_delete(slot: Slot) -> Result<(), CredentialError> {
    clear(&WindowsCredentialStore, slot)
}

#[cfg(test)]
pub(crate) mod memory {
    use super::{CredentialError, CredentialStore};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory store for tests.
    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn get(&self, account: &str) -> Result<Option<String>, CredentialError> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), CredentialError> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), CredentialError> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory::MemoryStore;
    use super::*;

    #[test]
    fn round_trips_and_clears_a_slot() {
        let store = MemoryStore::default();
        assert_eq!(read(&store, Slot::AuthSession).unwrap(), None);
        write(&store, Slot::AuthSession, "{\"idToken\":\"t\"}").unwrap();
        assert_eq!(
            read(&store, Slot::AuthSession).unwrap().as_deref(),
            Some("{\"idToken\":\"t\"}")
        );
        clear(&store, Slot::AuthSession).unwrap();
        assert_eq!(read(&store, Slot::AuthSession).unwrap(), None);
    }

    #[test]
    fn rejects_oversized_values() {
        let store = MemoryStore::default();
        let big = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(matches!(
            write(&store, Slot::AuthSession, &big),
            Err(CredentialError::TooLarge)
        ));
    }

    #[test]
    fn slot_names_are_fixed() {
        assert_eq!(Slot::AuthSession.account(), "auth-session");
        let parsed: Slot = serde_json::from_str("\"authSession\"").unwrap();
        assert_eq!(parsed, Slot::AuthSession);
        assert!(serde_json::from_str::<Slot>("\"anything-else\"").is_err());
    }
}
