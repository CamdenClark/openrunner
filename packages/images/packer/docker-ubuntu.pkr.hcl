packer {
  required_plugins {
    docker = {
      version = ">= 1.0.0"
      source  = "github.com/hashicorp/docker"
    }
  }
}

source "docker" "ubuntu" {
  image  = "ubuntu:22.04"
  commit = true
  changes = [
    "ENTRYPOINT [\"/usr/local/bin/openrunner\"]",
    "CMD [\"job-worker\"]",
    "USER runner",
    "WORKDIR /home/runner",
    "ENV LANG=en_US.UTF-8",
    "ENV LC_ALL=en_US.UTF-8",
  ]
}

build {
  sources = ["source.docker.ubuntu"]

  # Copy the compiled runner binary
  provisioner "file" {
    source      = var.runner_binary
    destination = "/usr/local/bin/openrunner"
  }

  provisioner "shell" {
    inline = ["chmod +x /usr/local/bin/openrunner"]
  }

  # Base packages
  provisioner "shell" {
    script = "${path.root}/../scripts/base.sh"
  }

  # Node.js
  provisioner "shell" {
    script = "${path.root}/../scripts/node.sh"
    environment_vars = [
      "NODE_VERSION=${var.node_version}",
    ]
  }

  # Python
  provisioner "shell" {
    script = "${path.root}/../scripts/python.sh"
    environment_vars = [
      "PYTHON_VERSION=${var.python_version}",
    ]
  }

  # Bun
  provisioner "shell" {
    script = "${path.root}/../scripts/bun.sh"
    environment_vars = [
      "BUN_VERSION=${var.bun_version}",
    ]
  }

  # Docker CLI
  provisioner "shell" {
    script = "${path.root}/../scripts/docker.sh"
    environment_vars = [
      "DOCKER_VERSION=${var.docker_cli_version}",
    ]
  }

  # GitHub CLI
  provisioner "shell" {
    script = "${path.root}/../scripts/gh-cli.sh"
    environment_vars = [
      "GH_CLI_VERSION=${var.gh_cli_version}",
    ]
  }

  # Cleanup
  provisioner "shell" {
    script = "${path.root}/../scripts/cleanup.sh"
  }

  post-processor "docker-tag" {
    repository = split(":", var.image_tag)[0]
    tags       = [split(":", var.image_tag)[1]]
  }
}
