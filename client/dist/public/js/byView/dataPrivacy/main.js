'use strict';
import { HttpClient } from '#@client/lib/old__clientUtils.js';
(async function () {
    const userProfileApi = new HttpClient('userprofile', '/api/data/userprofiles');
    const deleteOutputElem = document.getElementById('delete_output');
    const accountDelModal = new bootstrap.Modal(document.getElementById('account_delete_modal'));
    let userData;
    let status;
    try {
        ({ status, data: userData } = await userProfileApi.index());
        if (status == 200) {
            document.getElementById('delete_my_account_btn').addEventListener('click', async (e) => {
                await userProfileApi.delete(userData._id);
                deleteOutputElem.innerHTML = `Account: ${userData._id} <strong>marked for deletion</strong><br>If delete request was made in error, choose UNDELETE here:`;
                setTimeout(() => {
                    accountDelModal.hide();
                }, 20000);
                setTimeout(() => {
                    window.location.replace('/views/myaccount');
                }, 20000);
            });
            document.getElementById('undelete_my_account_btn').addEventListener('click', async (e) => {
                let resp = await axios.get('/api/util/undeleteme');
                deleteOutputElem.innerHTML = `Account: ${userData._id} delete flag <strong>removed</strong>.`;
                setTimeout(() => {
                    accountDelModal.hide();
                }, 5000);
            });
        }
        else {
            throw new Error('userprofile api reponded with an error');
        }
    }
    catch (error) {
        if (error.response?.data.errorMessage) {
            console.error(error.response.data.errorMessage);
        }
        else {
            console.error(error);
        }
    }
    if (!userData)
        return;
    document.querySelectorAll('.flexOption').forEach((switchElem) => {
        switchElem.checked = userData.computedFlexOptions.option[switchElem.id.replace('flexOpt-', '')];
    });
    document.getElementById('dataprivacy_form').addEventListener('change', async (e) => {
        const target = e.target;
        if (target.classList.contains('flexOption')) {
            const newData = {
                flexOptions: {
                    option: {}
                }
            };
            document.querySelectorAll('.flexOption').forEach((switchElem) => {
                newData.flexOptions.option[switchElem.id.replace('flexOpt-', '')] = switchElem.checked;
            });
            try {
                console.debug(JSON.stringify(newData, null, 2));
                const { status, data } = await userProfileApi.update(newData, userData._id);
                console.debug(status);
            }
            catch (error) {
                if (error.response?.data.errorMessage) {
                    console.error(error.response.data.errorMessage);
                }
                else {
                    console.error(error);
                }
            }
        }
    });
})();
//# sourceMappingURL=main.js.map