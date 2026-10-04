<?php
/**
 * wp-cloud mu-plugin (Lane-3 sites): bridges WP events to the platform agent.
 * - pings the in-container webhook on content changes (sync-out trigger)
 * - exposes a magic-login token endpoint for the dashboard
 * Install: wp-content/mu-plugins/wpcloud-mu.php
 */
defined('ABSPATH') || exit;

add_action('save_post', 'wpc_notify_change');
add_action('activated_plugin', 'wpc_notify_change');
add_action('switch_theme', 'wpc_notify_change');
function wpc_notify_change() {
    // debounce via transient — at most once per 60s
    if (get_transient('wpc_changed')) return;
    set_transient('wpc_changed', 1, 60);
    wp_remote_post('http://localhost:8080/hooks/sync-out', ['timeout' => 2, 'blocking' => false]);
}

// Effective-100%: reclassify the site whenever the plugin set changes.
// The agent runs compat-scan.sh which reports {slug, source} to the platform
// classifier → site variant auto-updates (mysql8/apache/daemons/multisite).
add_action('activated_plugin', 'wpc_trigger_compat_scan');
add_action('deactivated_plugin', 'wpc_trigger_compat_scan');
function wpc_trigger_compat_scan() {
    if (get_transient('wpc_scan_pending')) return;
    set_transient('wpc_scan_pending', 1, 120); // debounce 2min
    wp_remote_post('http://localhost:8080/hooks/compat-scan', ['timeout' => 2, 'blocking' => false]);
}

// Report next wp-cron due to the agent → DO cron-wake alarm wakes a sleeping
// site before the event fires (scheduled posts, Action Scheduler, backups).
add_action('shutdown', function () {
    if (get_transient('wpc_cron_reported')) return;
    $next = wp_next_scheduled('wp_version_check') ?: wp_next_scheduled('recovery_mode_clean_expired_sessions');
    if ($next) {
        set_transient('wpc_cron_reported', 1, 300);
        file_put_contents('/state/cron.json', json_encode(['next_due' => $next]));
    }
});

add_action('rest_api_init', function () {
    register_rest_route('wpc/v1', '/magic-login', [
        'methods' => 'GET',
        'permission_callback' => function ($req) {
            return hash_equals(get_option('wpc_magic_token', ''), $req->get_param('t') ?? '');
        },
        'callback' => function () {
            $user = get_users(['role' => 'administrator', 'number' => 1])[0] ?? null;
            if (!$user) return new WP_Error('no_admin', 'no admin', ['status' => 404]);
            wp_set_auth_cookie($user->ID);
            return ['redirect' => admin_url()];
        },
    ]);
});
