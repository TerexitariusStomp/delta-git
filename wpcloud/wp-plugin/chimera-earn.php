<?php
/**
 * Plugin Name: Chimera Earn — visitors power your site's AI (and get paid)
 * Description: Opt-in visitor compute. Visitors who click "Start earning" run
 *   small AI jobs (marketing copy, SEO meta, moderation) in their browser and
 *   get paid via on-chain escrow. The site's own AI work runs on its own
 *   traffic first. No compute without explicit consent.
 * Version: 0.1.0
 * License: GPL-2.0-or-later
 *
 * Settings: wp-admin → Settings → Chimera Earn
 *   - enable/disable the visitor earn card
 *   - coordinator WebSocket URL
 *   - site ID (defaults to a hash of home_url — must match the platform's site tag)
 */

defined('ABSPATH') || exit;

class Chimera_Earn {
    const OPT_ENABLED = 'chimera_earn_enabled';
    const OPT_COORD   = 'chimera_earn_coordinator';
    const OPT_SITE    = 'chimera_earn_site';
    const OPT_LABEL   = 'chimera_earn_label';
    const SDK_URL     = '/wp-content/plugins/chimera-earn/visitor-node.js';

    public static function init() {
        add_option(self::OPT_ENABLED, '1');
        add_option(self::OPT_COORD, 'wss://coordinator.localchimera.com');
        add_option(self::OPT_SITE, substr(md5(home_url()), 0, 12));
        add_option(self::OPT_LABEL, 'Earn while you browse');

        add_action('wp_enqueue_scripts', [__CLASS__, 'enqueue']);
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_init', [__CLASS__, 'settings']);
    }

    /** Inject the visitor-node script on public pages only — never wp-admin. */
    public static function enqueue() {
        if (is_admin() || !get_option(self::OPT_ENABLED)) return;
        wp_register_script('chimera-earn', plugins_url('visitor-node.js', __FILE__), [], '0.1.0', true);
        wp_enqueue_script('chimera-earn');
        // data-* attributes configure the embedded script
        add_filter('script_loader_tag', function ($tag, $handle) {
            if ($handle !== 'chimera-earn') return $tag;
            $site = esc_attr(get_option(self::OPT_SITE));
            $coord = esc_attr(get_option(self::OPT_COORD));
            $label = esc_attr(get_option(self::OPT_LABEL));
            return str_replace('<script ', "<script data-site=\"$site\" data-coordinator=\"$coord\" data-label=\"$label\" ", $tag);
        }, 10, 2);
    }

    public static function menu() {
        add_options_page('Chimera Earn', 'Chimera Earn', 'manage_options', 'chimera-earn', [__CLASS__, 'page']);
    }

    public static function settings() {
        foreach ([self::OPT_ENABLED, self::OPT_COORD, self::OPT_SITE, self::OPT_LABEL] as $opt)
            register_setting('chimera-earn', $opt, ['sanitize_callback' => 'sanitize_text_field']);
    }

    public static function page() { ?>
        <div class="wrap">
            <h1>Chimera Earn</h1>
            <form method="post" action="options.php">
                <?php settings_fields('chimera-earn'); ?>
                <table class="form-table">
                    <tr><th>Enable visitor earn card</th>
                        <td><input type="checkbox" name="<?= self::OPT_ENABLED ?>" value="1"
                            <?php checked(get_option(self::OPT_ENABLED), '1'); ?>></td></tr>
                    <tr><th>Coordinator WebSocket</th>
                        <td><input type="url" name="<?= self::OPT_COORD ?>" class="regular-text"
                            value="<?= esc_attr(get_option(self::OPT_COORD)) ?>"></td></tr>
                    <tr><th>Site ID (job routing tag)</th>
                        <td><input type="text" name="<?= self::OPT_SITE ?>" class="regular-text"
                            value="<?= esc_attr(get_option(self::OPT_SITE)) ?>"></td></tr>
                    <tr><th>Card label</th>
                        <td><input type="text" name="<?= self::OPT_LABEL ?>" class="regular-text"
                            value="<?= esc_attr(get_option(self::OPT_LABEL)) ?>"></td></tr>
                </table>
                <?php submit_button(); ?>
            </form>
            <p><em>Visitors only compute after clicking "Start earning" — never silently.
            Jobs run only while the tab is visible and the device isn't battery-low.
            Earnings stream via on-chain escrow with no minimum payout.</em></p>
        </div>
    <?php }
}

Chimera_Earn::init();
