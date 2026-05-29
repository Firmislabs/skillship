pub use crate::prelude::*;

/// Query parameters for projects
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq, Hash)]
pub struct ProjectsQueryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
}

impl ProjectsQueryRequest {
    pub fn builder() -> ProjectsQueryRequestBuilder {
        <ProjectsQueryRequestBuilder as Default>::default()
    }
}

#[derive(Clone, PartialEq, Default, Debug)]
#[non_exhaustive]
pub struct ProjectsQueryRequestBuilder {
    limit: Option<String>,
}

impl ProjectsQueryRequestBuilder {
    pub fn limit(mut self, value: impl Into<String>) -> Self {
        self.limit = Some(value.into());
        self
    }

    /// Consumes the builder and constructs a [`ProjectsQueryRequest`].
    pub fn build(self) -> Result<ProjectsQueryRequest, BuildError> {
        Ok(ProjectsQueryRequest { limit: self.limit })
    }
}
