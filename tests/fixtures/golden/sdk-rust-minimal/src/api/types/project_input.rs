pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectInput(pub HashMap<String, serde_json::Value>);
