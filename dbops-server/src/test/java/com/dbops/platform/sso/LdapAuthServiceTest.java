package com.dbops.platform.sso;

import com.dbops.platform.PlatformProperties;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class LdapAuthServiceTest {

    @Test
    void userDnPattern() {
        PlatformProperties props = mock(PlatformProperties.class);
        when(props.ldapUserDnPattern()).thenReturn("uid={username},ou=users,dc=corp,dc=com");
        when(props.ldapDomain()).thenReturn("");
        LdapAuthService ldap = new LdapAuthService(props);
        assertEquals("uid=alice,ou=users,dc=corp,dc=com", ldap.buildPrincipal("alice"));
    }

    @Test
    void domainSuffix() {
        PlatformProperties props = mock(PlatformProperties.class);
        when(props.ldapUserDnPattern()).thenReturn("uid={username}");
        when(props.ldapDomain()).thenReturn("corp.com");
        LdapAuthService ldap = new LdapAuthService(props);
        assertEquals("bob@corp.com", ldap.buildPrincipal("bob"));
    }
}
