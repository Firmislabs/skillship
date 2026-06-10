pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct LogsListResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<LogsListResponseDataItem>>,
}

impl LogsListResponse {
    pub fn builder() -> LogsListResponseBuilder {
        <LogsListResponseBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct LogsListResponseBuilder {
    data: Option<Vec<LogsListResponseDataItem>>,
}

impl LogsListResponseBuilder {
    pub fn data(mut self, value: Vec<LogsListResponseDataItem>) -> Self {
        self.data = Some(value);
        self
    }

    /// Consumes the builder and constructs a [`LogsListResponse`].
    pub fn build(self) -> Result<LogsListResponse, BuildError> {
        Ok(LogsListResponse { data: self.data })
    }
}
