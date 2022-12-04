import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class SSHConfigProvider extends ConfigProvider {
    defaults = {
        profiles: [
            {
                "type":"local",
                "name":"ssh2sftp_win_template",
                "icon":"fas fa-terminal",
                "options":{
                    "command":"/usr/bin/sftp",
                    "env":{
        
                    },
                    "cwd":""
                },
                "group":"ssh2sftp_template",
                "id":"local:custom:ssh2sftp_win_template:c617da05-d05c-482d-8ca6-3c7eb99452e9"
            },
            {
                "type":"local",
                "name":"ssh2sftp_linux_template",
                "icon":"fas fa-terminal",
                "options":{
                    "command":"/usr/bin/sftp",
                    "env":{
        
                    },
                    "cwd":""
                },
                "group":"ssh2sftp_template",
                "id":"local:custom:ssh2sftp_linux_template:6c4bcc75-f690-482a-a882-40e1c9851a3d"
            },
            {
                "type":"local",
                "name":"ssh2sftp_mac_template",
                "icon":"fas fa-terminal",
                "options":{
                    "command":"/usr/local/opt/openssh/bin/sftp",
                    "args":[
                        "-o",
                        "StrictHostKeyChecking=no"
                    ],
                    "env":{
        
                    },
                    "cwd":""
                },
                "id":"local:custom:ssh2sftp_mac_template:33162a26-7807-4c5e-ac2d-68cd2d9a4a24",
                "group":"ssh2sftp_template"
            }
        ],
        ssh: {
            warnOnClose: false,
            winSCPPath: null,
            agentType: 'auto',
            agentPath: null,
            x11Display: null,
            knownHosts: [],
            verifyHostKeys: true,
        },
        hotkeys: {
            'restart-ssh-session': [],
            'launch-winscp': [],
        },
    }

    platformDefaults = {}
}
