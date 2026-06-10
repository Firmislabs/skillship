pub use crate::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct ItemsListResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<ItemsListResponseDataItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl ItemsListResponse {
    pub fn builder() -> ItemsListResponseBuilder {
        <ItemsListResponseBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct ItemsListResponseBuilder {
    data: Option<Vec<ItemsListResponseDataItem>>,
    next_cursor: Option<String>,
}

impl ItemsListResponseBuilder {
    pub fn data(mut self, value: Vec<ItemsListResponseDataItem>) -> Self {
        self.data = Some(value);
        self
    }

    pub fn next_cursor(mut self, value: impl Into<String>) -> Self {
        self.next_cursor = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`ItemsListResponse`].
    pub fn build(self) -> Result<ItemsListResponse, BuildError> {
        Ok(ItemsListResponse {
            data: self.data,
            next_cursor: self.next_cursor,
        })
    }
}
