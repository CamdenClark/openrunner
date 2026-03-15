variable "node_version" {
  type    = string
  default = "20.19.0"
}

variable "python_version" {
  type    = string
  default = "3.12"
}

variable "bun_version" {
  type    = string
  default = "1.2.14"
}

variable "gh_cli_version" {
  type    = string
  default = "2.74.1"
}

variable "docker_cli_version" {
  type    = string
  default = "27.5.1"
}

variable "runner_binary" {
  type        = string
  description = "Path to the compiled openrunner binary for the target platform"
}

variable "image_tag" {
  type    = string
  default = "openrunner/runner:latest"
}
