pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct LogsListResponseDataItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl LogsListResponseDataItem {
    pub fn builder() -> LogsListResponseDataItemBuilder {
        <LogsListResponseDataItemBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct LogsListResponseDataItemBuilder {
    message: Option<String>,
}

impl LogsListResponseDataItemBuilder {
    pub fn message(mut self, value: impl Into<String>) -> Self {
        self.message = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`LogsListResponseDataItem`].
    pub fn build(self) -> Result<LogsListResponseDataItem, BuildError> {
        Ok(LogsListResponseDataItem {
            message: self.message,
        })
    }
}
