terraform {
  required_version = "= 1.13.2"
}

variable "name" {
  type    = string
  default = "native-fixture"
  validation {
    condition     = length(var.name) > 3
    error_message = "The fixture name is nonempty and explicit."
  }
}

resource "terraform_data" "fixture" {
  input = var.name
}

output "identity" {
  value = terraform_data.fixture.output
}
