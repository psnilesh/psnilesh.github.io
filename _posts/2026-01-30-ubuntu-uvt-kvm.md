---
title: Ubuntu virtual machines for those in a hurry
tags:
- Programming
layout: post
excerpt_separator: "<!--more-->"
---

A couple of weeks ago, I decided to setup a virtual machine in my Linux Mint machine to run some untrusted code. I was quite familiar with Virtualbox but I preferred a solution that didn't take me away from my terminal. I had heard about Qemu a lot so decided to give it a try.<!--more-->

I launched a Qemu VM with latest [Alpine ISO](https://www.alpinelinux.org/downloads/) and started going through the installation process. Unfortunately, it failed half-way through due to lack of network connectivity inside the guest OS. I had misconfigured the network bridge. I tried a couple of things to get it to work but eventually ran out of patience. Installation process itself was also longer than I liked for a quick VM spinup so I decided to explore other options. I then landed on [Cloud images](https://cloud-images.ubuntu.com/) that don't need installation to get started with, just like instances launched in any cloud provider. However, it still expected to configure _cloud-init_, which once again, I was too impatient for. While searching for ways to simplify or avoid having to specify _cloud-init_ at all, I came across this nifty tool by Ubuntu called `uvt-kvm` that fit the bill perfectly.

`uvt-kvm` is a virtualisation front-end for libvrt and kvm that works on Ubuntu and its derivatives, which was lucky for me as a Mint user. It is built on top of cloud images so it can launch a VM without going through guess OS installation process. It also ships with defaults that don't require user to configure _cloud-init_, or even know it's a thing. I tried it, and spinning up a VM has never felt easier,

First, install `uvtool`
```sh
$ sudo apt install -y uvtool
```

Now download you preferred cloud image to your machine,
```sh
$ uvt-simplestreams-libvirt sync release=noble arch=amd64
```
`noble` is the release name I chose. For full list of Ubuntu release names, refer [their documentation](https://documentation.ubuntu.com/project/release-team/list-of-releases/).

Then create the VM using `uvt-kvm`,
```sh
$ uvt-kvm create my-test-vm release=noble
$ uvt-kvm wait my-test-vm # Wait for the VM to create
```

Now you can ssh into it by running
```sh
$ uvt-kvm ssh my-test-vm
```

In few commands, we've setup a fully isolated Ubuntu VM that you can use for quick experiments. The tool sets it up with internet connectivity by default, just like I wanted. Further, you can connect VSCode or other editors for remote development by creating a regular SSH connection to VM's IP returned by command `uvt-kvm ip my-test-vm`. 


Don't forget to delete the VM when you no longer need it,
```sh
$ uvt-kvm list # To list all running VMs
$ uvt-kvm destroy my-test-vm
```

You can configure cpu, memory and disk storage made available to the VM easily through cli args. There are examples in the links below. 


It needs to be noted that this tool is only a wrapper over existing virtualization technologies, and a really convenient one at that. Currently, it is available only on Ubuntu (or its derivates) and can only launch Ubuntu virtual machines. I'm generally ok with any Debian system so this was fine with me. 

To whoever decided to build this tool - Thank you!

### References
1. [Cloud images and uvtool](https://people.canonical.com/~mwh/serverguidoke/build/serverguide/C/cloud-images-and-uvtool.html.en).
2. [uvt-kvm man page](https://manpages.ubuntu.com/manpages/focal/man1/uvt-kvm.1.html) 