package com.dbops.platform;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Springdoc OpenAPI（阶段3，扫描全量 com.dbops 控制器）。
 * 修改者: dxc | 时间: 2026-11-12
 */
@Configuration
public class PlatformOpenApiConfig {

    @Bean
    public OpenAPI dbopsOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("DB智能平台 API")
                        .description("Java dbops-server 接口文档（Node 转发接口见 docs/openapi-node.yaml）")
                        .version("4.3")
                        .contact(new Contact().name("DBOps").email("ops@example.com"))
                        .license(new License().name("Proprietary")));
    }

    @Bean
    public GroupedOpenApi dbopsApiGroup() {
        return GroupedOpenApi.builder()
                .group("dbops")
                .packagesToScan("com.dbops")
                .build();
    }
}
