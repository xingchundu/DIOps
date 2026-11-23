package com.dbops.config;

import com.dbops.security.AuthFilter;
import com.dbops.security.OriginCheckFilter;
import com.dbops.security.RateLimitFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 过滤器顺序：限流 → 来源校验 → 认证（与 Node 版 helmet/rateLimit/origin/auth 中间件顺序一致）
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final AllowedOrigins allowedOrigins;

    public WebConfig(AllowedOrigins allowedOrigins) {
        this.allowedOrigins = allowedOrigins;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOrigins(allowedOrigins.asSet().toArray(new String[0]))
                .allowedMethods("GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true)
                .maxAge(3600);
    }

    @Bean
    public FilterRegistrationBean<RateLimitFilter> rateLimitFilterRegistration(RateLimitFilter f) {
        FilterRegistrationBean<RateLimitFilter> r = new FilterRegistrationBean<>(f);
        r.addUrlPatterns("/*");
        r.setOrder(1);
        return r;
    }

    @Bean
    public FilterRegistrationBean<OriginCheckFilter> originCheckFilterRegistration(OriginCheckFilter f) {
        FilterRegistrationBean<OriginCheckFilter> r = new FilterRegistrationBean<>(f);
        r.addUrlPatterns("/*");
        r.setOrder(2);
        return r;
    }

    /** 授权拦截在登录校验之前：授权到期后任何接口（含转发给 Node 的）都不可用 */
    @Bean
    public FilterRegistrationBean<com.dbops.license.LicenseFilter> licenseFilterRegistration(com.dbops.license.LicenseFilter f) {
        FilterRegistrationBean<com.dbops.license.LicenseFilter> r = new FilterRegistrationBean<>(f);
        r.addUrlPatterns("/api/*");
        r.setOrder(3);
        return r;
    }

    @Bean
    public FilterRegistrationBean<AuthFilter> authFilterRegistration(AuthFilter f) {
        FilterRegistrationBean<AuthFilter> r = new FilterRegistrationBean<>(f);
        r.addUrlPatterns("/api/*");
        r.setOrder(4);
        return r;
    }
}
