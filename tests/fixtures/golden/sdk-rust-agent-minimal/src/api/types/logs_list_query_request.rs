pub use crate::prelude::*;

/// Query parameters for list
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct LogsListQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
}

impl LogsListQueryRequest {
    pub fn builder() -> LogsListQueryRequestBuilder {
        <LogsListQueryRequestBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct LogsListQueryRequestBuilder {
    limit: Option<i64>,
    offset: Option<i64>,
}

impl LogsListQueryRequestBuilder {
    pub fn limit(mut self, value: i64) -> Self {
        self.limit = Some(value);
        self
    }

    pub fn offset(mut self, value: i64) -> Self {
        self.offset = Some(value);
        self
    }

    /// Consumes the builder and constructs a [`LogsListQueryRequest`].
    pub fn build(self) -> Result<LogsListQueryRequest, BuildError> {
        Ok(LogsListQueryRequest {
            limit: self.limit,
            offset: self.offset,
        })
    }
}
