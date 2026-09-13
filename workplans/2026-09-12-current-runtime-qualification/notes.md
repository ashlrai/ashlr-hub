# Findings

Start: clean primary 40140282, previous implementation 29f3e055. Previous evaluator
25d57874 qualification does not transfer to current 9a051509 bytes. The requested
end state remains a useful autonomous company/fleet, not merely green local tests.

Confirmed with independent source review: first passed trial enters the archive
without a seed-relative comparison. Later parent delta can independently authorize
delivery; final seed custody and recovery checks only covered parentless trials.
Thus a fixed calibration passing145/144 can deliver144 against newer seed140.
Fix the delivery boundary, not exploration or the immutable calibration policy.

Collector investigation: no existing recovery route accepts v1 absent original
live lease ownership. A prospective same-machine checkpoint followed by a later
boot could provide local-process cessation evidence, but would be a new explicit
recovery protocol, not historical owner proof or remote settlement. Do not clear
the fence, reboot, invent owner metadata or reconstruct a lease.
