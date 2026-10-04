#!/usr/bin/env bash
# WP-Cron driver — DO-alarm or crond calls this; Action Scheduler safe
cd /srv/site && exec wp cron event run --due-now --allow-root
