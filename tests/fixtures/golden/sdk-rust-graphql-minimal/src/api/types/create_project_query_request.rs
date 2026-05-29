pub use crate::prelude::*;

/// Query parameters for createProject
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct CreateProjectQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
}

impl CreateProjectQueryRequest {
    pub fn builder() -> CreateProjectQueryRequestBuilder {
        <CreateProjectQueryRequestBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct CreateProjectQueryRequestBuilder {
    input: Option<String>,
}

impl CreateProjectQueryRequestBuilder {
    pub fn input(mut self, value: impl Into<String>) -> Self {
        self.input = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`CreateProjectQueryRequest`].
    pub fn build(self) -> Result<CreateProjectQueryRequest, BuildError> {
        Ok(CreateProjectQueryRequest { input: self.input })
    }
}
